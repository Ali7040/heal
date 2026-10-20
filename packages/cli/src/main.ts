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
import { watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import type { Detector } from '@self-heal/core/contracts/detector';
import type { Fixer } from '@self-heal/core/contracts/fixer';
import type { RunContext } from '@self-heal/core/contracts/context';
import type { Issue } from '@self-heal/core/contracts/issue';
import { buildDiagnosis } from '@self-heal/core/diagnosis/build';
import { GitRepo } from '@self-heal/core/git/repo';
import { createConsoleLogger } from '@self-heal/core/logger';
import { runCommand } from '@self-heal/core/process';
import { Runner, type IssueOutcome, type RunReport } from '@self-heal/core/runner/runner';
import { CommandDetector } from '@self-heal/detector-command';
import { ContractDetector } from '@self-heal/detector-contract';
import { VisualDetector } from '@self-heal/detector-visual';
import { HarnessFixer, UnverifiedHarnessError, createGitWorkspace } from '@self-heal/fixer-harness';
import { NoopFixer } from '@self-heal/fixer-noop';
import { openJournal, UnsupportedRuntimeError, type CallRecord, type Journal } from '@self-heal/journal/store';

import { loadConfig, ConfigError, EXAMPLE_CONFIG, type SelfHealConfig } from './config.js';
import { renderEscalation, writeEscalation } from './escalation.js';
import { renderRunMarkdown } from './report-md.js';
import { formatRunSpend, formatSpend, parseSince } from './stats.js';
import { selectDetectors } from './select.js';
import { HookError, installHook, prePushVerdict, uninstallHook } from './hook.js';
import { debounce, failingChecks, maybeRelevant, signaturesToHeal, statusChanges, type Failing } from './watch.js';

const USAGE = `self-heal — detect, propose, verify, record

Usage:
  self-heal run     [--dry-run] [--only <id,...>] [--config <path>] [--allow-dirty]
                    [--report-md <path>]
  self-heal init    [--config <path>]
  self-heal journal [--limit <n>] [--forget <signature>] [--json]
  self-heal stats   [--since <7d|24h|date>] [--json]
  self-heal watch   [--heal] [--only <id,...>] [--debounce <ms>]
  self-heal hook    install [--detect-only] | uninstall

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
  --report-md    run: also write the run as Markdown — outcomes, fix commits,
                 spend, escalations — for a PR body or a CI job summary.
  --no-journal   Do not consult or update the outcome journal. Every occurrence
                 of a known regression then pays for a fresh model call.
  --limit        journal: how many remembered outcomes to show (default 20).
  --forget       journal: delete one outcome by signature, so the next
                 occurrence is proposed fresh instead of replayed.
  --since        stats: only count what happened after this — a duration
                 (7d, 24h) or a date. Default: all time.
  --heal         watch: also fix a newly failing check — only on a clean tree
                 (just after a commit, say), and once per issue per session.
                 Without it, watching is detection only, and free.
  --debounce     watch: quiet time after the last change before re-measuring
                 (default 500 ms).
  --detect-only  hook install: block a failing push without calling a model.
  --pre-push     run: what the hook calls. Exit code is the push decision.
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
      since: { type: 'string' },
      'report-md': { type: 'string' },
      'pre-push': { type: 'boolean', default: false },
      'detect-only': { type: 'boolean', default: false },
      heal: { type: 'boolean', default: false },
      debounce: { type: 'string', default: '500' },
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
      case 'stats':
        return await statsCommand(values, cwd);
      case 'watch':
        return await watchCommand(values, cwd);
      case 'hook':
        return await hookCommand(values, positionals[1], cwd);
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

interface RunOptions {
  /** Overrides `--dry-run`, for watch mode's free detection cycles. */
  readonly dryRun?: boolean;
  /** No report on stdout and only errors logged — watch mode prints its own lines. */
  readonly quiet?: boolean;
  readonly onReport?: (report: RunReport) => void;
}

async function runCommand_(values: Record<string, unknown>, cwd: string, options: RunOptions = {}): Promise<number> {
  const config = await loadConfig(values['config'] as string, cwd);
  const dryRun = options.dryRun ?? values['dry-run'] === true;
  const prePush = values['pre-push'] === true;

  // Before a push, a dirty tree means the code being measured is not the code being
  // pushed — and the loop would refuse it anyway. Skip, say so, let the push go.
  if (prePush && !(await new GitRepo({ dir: config.repoRoot }).isClean())) {
    process.stderr.write(`${prePushVerdict({ dirty: true }).message}\n`);
    return 0;
  }

  const log = createConsoleLogger({
    level: options.quiet === true ? 'error' : values['verbose'] === true ? 'debug' : 'info',
  });

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
          priority: check.priority,
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

  // Signature → the hand-off written for it, so the report can point at it.
  const escalations = new Map<string, string>();
  // …and its text, for a Markdown report that folds it in (D-032).
  const handoffs = new Map<string, { path: string; markdown: string }>();
  const repo = new GitRepo({ dir: config.repoRoot });
  // Where the run started, so the fix commits it made can be listed afterwards.
  const startedAt = await repo.currentCommit();
  // Every model call this run, as the fixer measured it — for the run's own line,
  // and into the journal so `self-heal stats` can add it up later (D-029).
  const calls: CallRecord[] = [];
  const onInvoke = (call: CallRecord) => {
    calls.push(call);
    journal?.recordCall(call);
  };

  const runner = new Runner({
    detectors,
    fixer: buildFixer(values, config, dryRun, onInvoke),
    repo,
    ctx,
    // Absent means `NullJournal` — the runner has no "journal disabled" branch,
    // it just gets a journal that remembers nothing (phase 1's seam, now filled).
    ...(journal !== undefined ? { journal } : {}),
    allowlist: config.allowlist,
    // What a model may not see, it may not write either: a patch "creating" `.env`
    // would overwrite the real one (D-031).
    protectedPaths: [...config.protected, ...config.sandboxExclude],
    attemptCap: config.attemptCap,
    failureThreshold: config.failureThreshold,
    collateralCheck: config.collateral,
    confirmFailures: config.confirmFailures,
    allowDirty: values['allow-dirty'] === true,
    diagnose: (issue: Issue) =>
      buildDiagnosis(issue, {
        repoRoot: config.repoRoot,
        editableFiles: editableFor(issue, config),
        exclude: config.sandboxExclude,
      }),
    onEscalate: async (escalation) => {
      const path = await writeEscalation(escalation, ctx.evidenceDir);
      const shown = relative(config.repoRoot, path).split('\\').join('/');
      escalations.set(escalation.issue.signature, shown);
      handoffs.set(escalation.issue.signature, { path: shown, markdown: renderEscalation(escalation) });
    },
    onTransition: (event) => log.debug(`${event.from} → ${event.to}`, event.detail ?? {}),
  });

  const report = await runner.run();
  const savings = journal?.stats();
  journal?.close();
  options.onReport?.(report);

  const reportMd = values['report-md'];
  if (typeof reportMd === 'string' && reportMd !== '') {
    const commits = await commitsSince(repo, startedAt);
    const markdown = renderRunMarkdown({ report, escalations: handoffs, calls, commits });
    await writeFile(resolve(cwd, reportMd), markdown, 'utf8');
  }

  if (options.quiet === true) {
    // Watch mode reads the report through `onReport` and prints its own lines.
  } else if (values['json'] === true) {
    process.stdout.write(`${JSON.stringify({ ...report, calls }, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(report.outcomes, report.issues, dryRun, escalations));
    process.stdout.write(formatRunSpend(calls));
    if (savings !== undefined && savings.replays > 0) {
      const line = `journal: ${savings.replays} model call(s) skipped, ${savings.verified} verified fix(es) remembered`;
      process.stdout.write(`${line}\n`);
    }
  }

  // The hook's exit code is a push decision, not a run outcome (D-036).
  if (prePush) {
    const verdict = prePushVerdict({ dirty: false, report });
    process.stderr.write(`\n${verdict.message}\n`);
    return verdict.code;
  }

  if (report.halted) {
    if (options.quiet !== true) process.stderr.write(`halted: ${report.haltReason}\n`);
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
 * `self-heal hook install|uninstall` (D-036). Only ever touches a hook it wrote.
 */
async function hookCommand(values: Record<string, unknown>, action: string | undefined, cwd: string): Promise<number> {
  const repo = new GitRepo({ dir: cwd });
  if (!(await repo.isRepo())) {
    process.stderr.write(`${cwd} is not a git repository\n`);
    return 2;
  }

  try {
    if (action === 'install') {
      const detectOnly = values['detect-only'] === true;
      const result = await installHook(repo, { detectOnly, config: values['config'] as string });
      process.stdout.write(
        `${result.status} ${result.path}\n` +
          (detectOnly
            ? 'pushes will be checked, and stopped while a check fails — no model is called.\n'
            : 'pushes will be checked and failures fixed first; stopped while anything still fails.\n') +
          'bypass once with `git push --no-verify`; remove with `self-heal hook uninstall`.\n',
      );
      return 0;
    }
    if (action === 'uninstall') {
      const result = await uninstallHook(repo);
      const said = {
        removed: `removed ${result.path}`,
        absent: 'no pre-push hook installed',
        foreign: `${result.path} was not written by self-heal; left alone`,
      }[result.status];
      process.stdout.write(`${said}\n`);
      return result.status === 'foreign' ? 1 : 0;
    }
  } catch (error) {
    if (error instanceof HookError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  process.stderr.write('usage: self-heal hook install [--detect-only] | self-heal hook uninstall\n');
  return 1;
}

/** Stands for "HEAD moved" — a commit or checkout, which changes no working file. */
const HEAD_MOVED = '\0HEAD';

/**
 * `self-heal watch` (D-036). Detection on every save, which is free; healing only
 * with `--heal`, on a clean tree, once per issue per session.
 */
async function watchCommand(values: Record<string, unknown>, cwd: string): Promise<number> {
  const config = await loadConfig(values['config'] as string, cwd);
  const repo = new GitRepo({ dir: config.repoRoot });
  const heal = values['heal'] === true;
  const delay = Number.parseInt(String(values['debounce'] ?? '500'), 10);
  const debounceMs = Number.isFinite(delay) && delay >= 0 ? delay : 500;

  const out = (line: string) => process.stdout.write(`${new Date().toLocaleTimeString()}  ${line}\n`);
  const attempted = new Set<string>();
  let previous = new Map<string, Failing>();
  let running = false;
  let hinted = false;
  let first = true;

  const measure = async (overrides: Record<string, unknown>, dryRun: boolean): Promise<RunReport | undefined> => {
    let report: RunReport | undefined;
    await runCommand_({ ...values, ...overrides }, cwd, {
      dryRun,
      quiet: true,
      onReport: (r) => {
        report = r;
      },
    });
    return report;
  };

  const cycle = async (): Promise<void> => {
    running = true;
    try {
      const detected = await measure({}, true);
      if (detected === undefined) return;
      if (detected.halted) {
        out(`skipped: ${detected.haltReason ?? 'the run halted'}`);
        return;
      }
      let current = failingChecks(detected);
      for (const line of statusChanges(previous, current)) out(line);
      if (first && current.size === 0) out('✔ all checks pass');
      first = false;

      const clean = await repo.isClean();
      const toHeal = signaturesToHeal({ heal, clean, failing: current, attempted });
      if (toHeal.length > 0) {
        // Narrowed to the detectors that own something untried, so an issue already
        // escalated this session is not paid for again.
        const owners = [
          ...new Set(detected.outcomes.filter((o) => toHeal.includes(o.issue.signature)).map((o) => o.issue.detectorId)),
        ];
        for (const o of detected.outcomes) if (owners.includes(o.issue.detectorId)) attempted.add(o.issue.signature);
        out(`healing: ${owners.join(', ')}…`);
        const healed = await measure({ only: owners }, false);
        if (healed !== undefined && !healed.halted) {
          for (const o of healed.outcomes) out(`  ${o.state} ${o.issue.detectorId}: ${o.reason}`);
          const fixed = new Set(
            healed.outcomes.filter((o) => o.state === 'HEALED' || o.state === 'RESOLVED').map((o) => o.issue.signature),
          );
          current = new Map([...current].filter(([, f]) => !fixed.has(f.signature)));
        } else if (healed?.halted === true) {
          out(`skipped healing: ${healed.haltReason ?? 'the run halted'}`);
        }
      } else if (heal && !clean && current.size > 0 && !hinted) {
        out('  uncommitted changes: commit or stash to let self-heal fix it');
        hinted = true;
      }
      previous = current;
    } catch (error) {
      out(`error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };

  const flush = async (paths: string[]): Promise<void> => {
    // Changes while a run is in progress are mostly its own (checkpoints, restores,
    // fix commits). Dropping them is what keeps a heal from triggering itself.
    if (running) return;
    const moved = paths.includes(HEAD_MOVED);
    const candidates = paths
      .filter((p) => p !== HEAD_MOVED)
      .map((p) => p.split('\\').join('/'))
      .filter(maybeRelevant);
    if (!moved && candidates.length === 0) return;
    if (!moved && (await allIgnored(config.repoRoot, candidates))) return;
    await cycle();
  };

  const trigger = debounce(debounceMs, (paths) => void flush(paths));
  const watchers = [
    watch(config.repoRoot, { recursive: true }, (_event, name) => {
      if (name !== null) trigger(String(name));
    }),
  ];
  const headLog = await repo.gitPath('logs/HEAD');
  try {
    if (headLog !== null) watchers.push(watch(headLog, () => trigger(HEAD_MOVED)));
  } catch {
    // No commits yet: there is no reflog to watch, and nothing to heal from either.
  }

  out(
    `watching ${config.repoRoot} — ${heal ? 'detecting, and healing on a clean tree' : 'detecting only, no model calls'}. Ctrl+C to stop.`,
  );
  await cycle();

  await new Promise<void>((done) =>
    process.once('SIGINT', () => {
      for (const watcher of watchers) watcher.close();
      done();
    }),
  );
  return 0;
}

/** True when git ignores every one of these paths — build output, caches, logs. */
async function allIgnored(repoRoot: string, paths: readonly string[]): Promise<boolean> {
  const result = await runCommand('git', ['check-ignore', '--stdin'], {
    cwd: repoRoot,
    stdin: paths.join('\n'),
    timeoutMs: 10_000,
  });
  // Exit 1 means "none ignored"; anything else unexpected means "do not skip".
  if (result.code !== 0) return false;
  const ignored = new Set(
    result.stdout
      .split('\n')
      .map((line) => line.trim().split('\\').join('/'))
      .filter(Boolean),
  );
  return paths.every((path) => ignored.has(path));
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
/** The commits made since `start`, oldest first. Empty when nothing was committed or git cannot say. */
async function commitsSince(repo: GitRepo, start: string | null): Promise<{ sha: string; subject: string }[]> {
  if (start === null) return [];
  const log = await repo.git('log', '--reverse', '--format=%h%x09%s', `${start}..HEAD`);
  if (!log.ok) return [];
  return log.stdout
    .split('\n')
    .filter((line) => line.includes('\t'))
    .map((line) => {
      const [sha = '', ...subject] = line.split('\t');
      return { sha, subject: subject.join('\t') };
    });
}

/** What the loop has spent, and what it bought (D-029). */
async function statsCommand(values: Record<string, unknown>, cwd: string): Promise<number> {
  const config = await loadConfig(values['config'] as string, cwd);
  const since = typeof values['since'] === 'string' ? parseSince(values['since']) : undefined;
  const journal = await openJournalOrExplain(config, createConsoleLogger({ level: 'warn' }));
  if (journal === undefined) return 4;

  try {
    const report = journal.spend(since !== undefined ? { since } : {});
    process.stdout.write(values['json'] === true ? `${JSON.stringify(report, null, 2)}\n` : formatSpend(report));
    return 0;
  } finally {
    journal.close();
  }
}

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
function buildFixer(
  values: Record<string, unknown>,
  config: SelfHealConfig,
  dryRun: boolean,
  onInvoke: (call: CallRecord) => void,
): Fixer {
  if (dryRun || values['fixer'] === 'noop') return new NoopFixer();

  const requested = values['fixer'];
  if (requested !== 'harness') {
    throw new ConfigError(`unknown --fixer "${String(requested)}". Use "harness" or "noop".`);
  }

  try {
    return new HarnessFixer({
      harness: config.harness,
      // The harness edits a copy in the OS temp directory, never the user's tree.
      // It is built per proposal and destroyed afterwards, so nothing a model does
      // outlives the attempt that did it. Secrets are never copied in (D-031).
      createWorkspace: () => createGitWorkspace({ repoRoot: config.repoRoot, exclude: config.sandboxExclude }),
      onInvoke,
      allowUnverified: config.allowUnverifiedHarness,
    });
  } catch (error) {
    // Refused before any detector runs, as a config problem with a readable fix.
    if (error instanceof UnverifiedHarnessError) throw new ConfigError(error.message);
    throw error;
  }
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

function formatReport(
  outcomes: readonly IssueOutcome[],
  issues: number,
  dryRun: boolean,
  escalations: ReadonlyMap<string, string>,
): string {
  if (issues === 0) return 'no issues detected\n';

  const lines = outcomes.map((outcome) => {
    const marker = { HEALED: '✔', RESOLVED: '✔', FLAKY: '~', PROPOSED: '·', REVERTED: '✗', ESCALATED: '!' }[
      outcome.state
    ];
    const line = `${marker} ${outcome.state.padEnd(9)} ${outcome.issue.kind} [${outcome.issue.signature.slice(0, 8)}] ${outcome.reason}`;
    const handoff = escalations.get(outcome.issue.signature);
    return handoff === undefined ? line : `${line}\n    → what was tried, and why it failed: ${handoff}`;
  });

  const healed = outcomes.filter((o) => o.state === 'HEALED' || o.state === 'RESOLVED').length;
  const summary = dryRun
    ? `${outcomes.length} issue(s) — dry run, nothing written`
    : `${healed}/${outcomes.length} healed`;

  return `${lines.join('\n')}\n\n${summary}\n`;
}

process.exitCode = await main(process.argv.slice(2));
