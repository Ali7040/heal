#!/usr/bin/env node
/**
 * The CLI is deliberately thin: parse, load config, build the wiring, hand off to
 * the runner, print the report. No loop logic lives here — if it did, the engine
 * would only be usable through this one front door.
 *
 * The wiring below is the whole composition root of the system. Everything the
 * runner needs is constructed here and injected, which is why the runner itself
 * has no knowledge of harnesses, git shims, or file systems.
 */
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Detector } from '@self-heal/core/contracts/detector';
import type { Fixer } from '@self-heal/core/contracts/fixer';
import type { RunContext } from '@self-heal/core/contracts/context';
import type { Issue } from '@self-heal/core/contracts/issue';
import { buildDiagnosis } from '@self-heal/core/diagnosis/build';
import { GitRepo } from '@self-heal/core/git/repo';
import { createConsoleLogger } from '@self-heal/core/logger';
import { Runner, type IssueOutcome } from '@self-heal/core/runner/runner';
import { CommandDetector } from '@self-heal/detector-command';
import { ContractDetector } from '@self-heal/detector-contract';
import { VisualDetector } from '@self-heal/detector-visual';
import { HarnessFixer, createGitWorkspace } from '@self-heal/fixer-harness';
import { NoopFixer } from '@self-heal/fixer-noop';
import { openJournal, UnsupportedRuntimeError, type Journal } from '@self-heal/journal/store';

import { loadConfig, ConfigError, EXAMPLE_CONFIG, type SelfHealConfig } from './config.js';
import { selectDetectors } from './select.js';

const USAGE = `self-heal — detect, propose, verify, record

Usage:
  self-heal run     [--dry-run] [--only <id,...>] [--config <path>] [--allow-dirty]
  self-heal init    [--config <path>]
  self-heal journal [--limit <n>] [--forget <signature>] [--json]

Options:
  --dry-run      Detect, diagnose, and propose — then stop and print the patch.
                 Nothing is written and no checkpoint is committed.
  --allow-dirty  Proceed with uncommitted changes. Off by default: a dirty tree
                 means a clean rollback cannot be promised.
  --only         Run only the named detectors, by id. Repeatable, or comma
                 separated. A name matching nothing is an error, never an
                 empty run.
  --config       Path to config (default: ./self-heal.config.json)
  --verbose      Include debug-level log lines.
  --json         Emit the run report as JSON on stdout.
  --no-journal   Do not consult or update the outcome journal. Every occurrence
                 of a known regression then pays for a fresh model call.
  --limit        journal: how many remembered outcomes to show (default 20).
  --forget       journal: delete one outcome by signature, so the next
                 occurrence is proposed fresh instead of replayed.
  --fixer        "harness" (default) drives the agent CLI you already have
                 installed. "noop" proposes nothing — the loop still detects,
                 diagnoses, and reports, for free. --dry-run implies "noop".
`;

export async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      'dry-run': { type: 'boolean', default: false },
      'allow-dirty': { type: 'boolean', default: false },
      config: { type: 'string', default: './self-heal.config.json' },
      verbose: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      journal: { type: 'boolean', default: true },
      fixer: { type: 'string', default: 'harness' },
      only: { type: 'string', multiple: true },
      limit: { type: 'string', default: '20' },
      forget: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help === true || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help === true ? 0 : 1;
  }

  const cwd = process.cwd();

  try {
    switch (positionals[0]) {
      case 'init': {
        const target = resolve(cwd, values.config as string);
        await writeFile(target, EXAMPLE_CONFIG, { encoding: 'utf8', flag: 'wx' });
        process.stdout.write(`wrote ${target}\n`);
        if (await ignoreArtifacts(cwd)) process.stdout.write(`updated ${resolve(cwd, '.gitignore')}\n`);
        return 0;
      }
      case 'run':
        return await runCommand_(values, cwd);
      case 'journal':
        return await journalCommand(values, cwd);
      default:
        process.stderr.write(`unknown command: ${positionals[0]}\n\n${USAGE}`);
        return 1;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    // An unexpected throw is a bug, not a run outcome. Say so, distinctly.
    process.stderr.write(`unexpected error: ${error instanceof Error ? error.stack : String(error)}\n`);
    return 70;
  }
}

async function runCommand_(values: Record<string, unknown>, cwd: string): Promise<number> {
  const config = await loadConfig(values['config'] as string, cwd);
  const dryRun = values['dry-run'] === true;

  const log = createConsoleLogger({ level: values['verbose'] === true ? 'debug' : 'info' });

  // Three detector kinds, one list. The runner is handed `Detector[]` and cannot
  // tell which is which — that indistinguishability is the whole claim of the
  // plugin boundary, so it is worth noticing that this is the only place in the
  // codebase where all three appear together.
  const allDetectors: Detector[] = [
    ...config.checks.map(
      (check) =>
        new CommandDetector({
          id: check.id,
          command: check.command,
          args: check.args ?? [],
          editable: check.editable,
          ...(check.timeoutMs !== undefined ? { timeoutMs: check.timeoutMs } : {}),
        }),
    ),
    ...(config.contracts === undefined ? [] : [buildContractDetector(config.contracts)]),
    ...(config.visual === undefined ? [] : [buildVisualDetector(config.visual)]),
  ];

  // Filtered before anything else happens, so `--only nonsense` fails at once
  // rather than after a journal is opened and a checkpoint commit exists.
  const detectors = selectDetectors(allDetectors, values['only'] as string[] | undefined);

  // Said out loud, because a narrowed run that exits 0 must not be mistaken for
  // a clean bill of health on the whole repository.
  if (detectors.length < allDetectors.length) {
    const skipped = allDetectors.filter((d) => !detectors.includes(d)).map((d) => d.id);
    log.warn(`--only: not measuring ${skipped.join(', ')}`);
  }

  // Opened before the runner so a broken journal is a startup failure with a
  // readable message, not something discovered after a checkpoint commit exists.
  const journal = values['journal'] === false ? undefined : await openJournalOrExplain(config, log);

  const ctx: RunContext = {
    repoRoot: config.repoRoot,
    evidenceDir: resolve(config.repoRoot, config.evidenceDir),
    dryRun,
    config: {},
    log,
  };

  const runner = new Runner({
    detectors,
    fixer: buildFixer(values, config, dryRun),
    repo: new GitRepo({ dir: config.repoRoot }),
    ctx,
    // Absent means `NullJournal` — the runner has no "journal disabled" branch,
    // it just gets a journal that remembers nothing (phase 1's seam, now filled).
    ...(journal !== undefined ? { journal } : {}),
    allowlist: config.allowlist,
    protectedPaths: config.protected,
    attemptCap: config.attemptCap,
    failureThreshold: config.failureThreshold,
    allowDirty: values['allow-dirty'] === true,
    diagnose: (issue: Issue) =>
      buildDiagnosis(issue, {
        repoRoot: config.repoRoot,
        editableFiles: editableFor(issue, config),
      }),
    onTransition: (event) => log.debug(`${event.from} → ${event.to}`, event.detail ?? {}),
  });

  const report = await runner.run();
  const savings = journal?.stats();
  journal?.close();

  if (values['json'] === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(report.outcomes, report.issues, dryRun));
    if (savings !== undefined && savings.replays > 0) {
      const line = `journal: ${savings.replays} model call(s) skipped, ${savings.verified} verified fix(es) remembered`;
      process.stdout.write(`${line}\n`);
    }
  }

  if (report.halted) {
    process.stderr.write(`halted: ${report.haltReason}\n`);
    return 3;
  }

  // Exit code carries the outcome so CI can act on it: anything unhealed is a
  // failure, because the point is that the repo ends healthy.
  const unresolved = report.outcomes.filter(
    (o) => o.state !== 'HEALED' && o.state !== 'RESOLVED' && o.state !== 'PROPOSED',
  );
  return unresolved.length > 0 ? 1 : 0;
}

/**
 * Open the journal, or explain why the run will be paying full price.
 *
 * A missing journal is a cost problem, never a correctness one — every outcome is
 * still measured. So an unusable one degrades to no memory with a warning rather
 * than halting a run that would otherwise have worked.
 */
async function openJournalOrExplain(config: SelfHealConfig, log: ReturnType<typeof createConsoleLogger>): Promise<Journal | undefined> {
  try {
    return await openJournal(resolve(config.repoRoot, config.journalPath));
  } catch (error) {
    if (error instanceof UnsupportedRuntimeError) {
      log.warn(`journal disabled: ${error.message}`);
      return undefined;
    }
    throw error;
  }
}

/**
 * Keep run artifacts out of git.
 *
 * Not housekeeping — a correctness problem. Evidence files land in
 * `.self-heal/evidence/` and the journal in `.self-heal/journal.sqlite`; an
 * untracked file makes the tree dirty, and a dirty tree halts the *next* run
 * (invariant 5). Left alone, the tool disables itself after one successful run,
 * for a reason that looks nothing like the cause.
 *
 * The `-*` entry covers SQLite's WAL and shared-memory siblings, which appear
 * only while a database is open and would otherwise dirty the tree mid-run.
 *
 * Recorded contracts are deliberately NOT ignored: those are reviewed and
 * committed, and are the only human judgement in the loop.
 */
async function ignoreArtifacts(cwd: string): Promise<boolean> {
  const target = resolve(cwd, '.gitignore');
  const existing = await readFile(target, 'utf8').catch(() => '');
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  const missing = IGNORE_ENTRIES.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return false;

  const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n';
  const heading = '# self-heal run artifacts (recorded contracts stay tracked)';
  const block = `\n${heading}\n${missing.join('\n')}\n`;
  await writeFile(target, `${existing}${prefix}${block}`, 'utf8');
  return true;
}

const IGNORE_ENTRIES = ['.self-heal/evidence/', '.self-heal/journal.sqlite', '.self-heal/journal.sqlite-*'];

function buildContractDetector(contracts: NonNullable<SelfHealConfig['contracts']>): ContractDetector {
  return new ContractDetector({
    id: contracts.id,
    endpoints: contracts.endpoints.map((endpoint) => ({
      name: endpoint.name,
      url: endpoint.url,
      ...(endpoint.method !== undefined ? { method: endpoint.method } : {}),
      ...(endpoint.headers !== undefined ? { headers: endpoint.headers } : {}),
      editable: endpoint.editable,
    })),
    ...(contracts.server !== undefined ? { server: contracts.server } : {}),
    ...(contracts.contractsDir !== undefined ? { contractsDir: contracts.contractsDir } : {}),
    ...(contracts.strict === true ? { strict: true } : {}),
    ...(contracts.record !== undefined ? { record: contracts.record } : {}),
  });
}

/**
 * Show what the journal remembers, or forget one row.
 *
 * The first thing anyone wants after a surprising replay is to see the record
 * that caused it — and, occasionally, to remove it. Without this the only window
 * into the store was a summary line at the end of a run, which is enough to know
 * something was replayed and not enough to know what.
 */
async function journalCommand(values: Record<string, unknown>, cwd: string): Promise<number> {
  const config = await loadConfig(values['config'] as string, cwd);
  const log = createConsoleLogger({ level: 'warn' });
  const journal = await openJournalOrExplain(config, log);
  if (journal === undefined) return 4;

  const out = (line: string) => process.stdout.write(`${line}\n`);

  try {
    const forget = values['forget'];
    if (typeof forget === 'string' && forget !== '') {
      const result = journal.forget(forget);
      if (result.status === 'forgotten') {
        out(`forgot ${result.signature}`);
        return 0;
      }
      if (result.status === 'ambiguous') {
        // Deleting the wrong remembered fix would be silent, and the next run
        // would quietly pay for a proposal nobody expected.
        out(`"${forget}" matches ${result.matches.length} outcomes:`);
        for (const match of result.matches) out(`  ${match}`);
        return 1;
      }
      out(`no outcome matching "${forget}"`);
      return 1;
    }

    const limit = Number.parseInt(String(values['limit'] ?? '20'), 10);
    const entries = journal.list(Number.isFinite(limit) && limit > 0 ? limit : 20);
    const stats = journal.stats();

    if (values['json'] === true) {
      out(JSON.stringify({ stats, entries }, null, 2));
      return 0;
    }

    if (entries.length === 0) {
      out('journal is empty — nothing has been measured yet');
      return 0;
    }

    for (const entry of entries) {
      // `verified` is the only column that decides whether a row is ever offered
      // again, so it leads.
      const mark = entry.verified ? '✔' : '✗';
      const replays = entry.replays > 0 ? `  ${entry.replays} replay(s)` : '';
      const files = entry.files.join(', ') || '(no files)';
      out(`${mark} ${entry.signature.slice(0, 8)}  ${entry.kind.padEnd(18)} ${files}${replays}`);
      out(`  first seen ${entry.firstSeen}   last seen ${entry.lastSeen}`);
    }

    out(`\n${stats.total} remembered, ${stats.verified} verified, ${stats.replays} model call(s) skipped so far`);
    return 0;
  } finally {
    journal.close();
  }
}

/**
 * Which fixer this run gets.
 *
 * A dry run never reaches `APPLYING`, so a fixer that costs money there would be
 * spending it to produce a patch nobody applies. `--dry-run` therefore implies
 * the noop fixer, which keeps the promise of the flag literal: nothing written,
 * nothing spent.
 *
 * Everything else defaults to the real harness. Shipping the noop fixer as the
 * default made `self-heal run` a command that detected problems and then did
 * nothing about them — the loop existed, but only the demo could close it.
 */
function buildFixer(values: Record<string, unknown>, config: SelfHealConfig, dryRun: boolean): Fixer {
  if (dryRun || values['fixer'] === 'noop') return new NoopFixer();

  const requested = values['fixer'];
  if (requested !== 'harness') {
    throw new ConfigError(`unknown --fixer "${String(requested)}". Use "harness" or "noop".`);
  }

  return new HarnessFixer({
    harness: config.harness,
    // The harness edits a copy in the OS temp directory, never the user's tree.
    // It is built per proposal and destroyed afterwards, so nothing a model does
    // outlives the attempt that did it.
    createWorkspace: () => createGitWorkspace({ repoRoot: config.repoRoot }),
  });
}

function buildVisualDetector(visual: NonNullable<SelfHealConfig['visual']>): VisualDetector {
  return new VisualDetector({
    id: visual.id,
    views: visual.views.map((view) => ({ name: view.name, url: view.url, editable: view.editable })),
    ...(visual.server !== undefined ? { server: visual.server } : {}),
    ...(visual.baselineDir !== undefined ? { baselineDir: visual.baselineDir } : {}),
    ...(visual.tolerance !== undefined ? { tolerance: visual.tolerance } : {}),
    ...(visual.maxRatio !== undefined ? { maxRatio: visual.maxRatio } : {}),
    ...(visual.record !== undefined ? { record: visual.record } : {}),
  });
}

/**
 * Which files a fixer may edit for this issue.
 *
 * Narrower than the allowlist on purpose: the allowlist is what the system will
 * *permit*, while this is what is actually relevant to one failure. Handing a
 * fixer the full allowlist for a single dropped API field invites it to go
 * exploring.
 */
function editableFor(issue: Issue, config: SelfHealConfig): readonly string[] {
  const check = config.checks.find((candidate) => candidate.id === issue.detectorId);
  if (check !== undefined) return check.editable;

  if (config.contracts?.id === issue.detectorId) {
    const endpoint = config.contracts.endpoints.find((candidate) => candidate.name === issue.location.endpoint);
    if (endpoint !== undefined) return endpoint.editable;
  }

  if (config.visual?.id === issue.detectorId) {
    // A visual issue carries its view name in `location.selector` — the frontend
    // half of `IssueLocation`.
    const view = config.visual.views.find((candidate) => candidate.name === issue.location.selector);
    if (view !== undefined) return view.editable;
  }

  return config.allowlist;
}

function formatReport(outcomes: readonly IssueOutcome[], issues: number, dryRun: boolean): string {
  if (issues === 0) return 'no issues detected\n';

  const lines = outcomes.map((outcome) => {
    const marker = { HEALED: '✔', RESOLVED: '✔', PROPOSED: '·', REVERTED: '✗', ESCALATED: '!' }[outcome.state];
    return `${marker} ${outcome.state.padEnd(9)} ${outcome.issue.kind} [${outcome.issue.signature.slice(0, 8)}] ${outcome.reason}`;
  });

  const healed = outcomes.filter((o) => o.state === 'HEALED' || o.state === 'RESOLVED').length;
  const summary = dryRun
    ? `${outcomes.length} issue(s) — dry run, nothing written`
    : `${healed}/${outcomes.length} healed`;

  return `${lines.join('\n')}\n\n${summary}\n`;
}

process.exitCode = await main(process.argv.slice(2));
