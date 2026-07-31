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
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Detector } from '@self-heal/core/contracts/detector';
import type { RunContext } from '@self-heal/core/contracts/context';
import type { Issue } from '@self-heal/core/contracts/issue';
import { buildDiagnosis } from '@self-heal/core/diagnosis/build';
import { GitRepo } from '@self-heal/core/git/repo';
import { createConsoleLogger } from '@self-heal/core/logger';
import { Runner, type IssueOutcome } from '@self-heal/core/runner/runner';
import { CommandDetector } from '@self-heal/detector-command';
import { NoopFixer } from '@self-heal/fixer-noop';

import { loadConfig, ConfigError, EXAMPLE_CONFIG, type SelfHealConfig } from './config.js';

const USAGE = `self-heal — detect, propose, verify, record

Usage:
  self-heal run  [--dry-run] [--config <path>] [--allow-dirty] [--verbose]
  self-heal init [--config <path>]

Options:
  --dry-run      Detect, diagnose, and propose — then stop and print the patch.
                 Nothing is written and no checkpoint is committed.
  --allow-dirty  Proceed with uncommitted changes. Off by default: a dirty tree
                 means a clean rollback cannot be promised.
  --config       Path to config (default: ./self-heal.config.json)
  --verbose      Include debug-level log lines.
  --json         Emit the run report as JSON on stdout.
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
        return 0;
      }
      case 'run':
        return await runCommand_(values, cwd);
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
  const detectors: Detector[] = config.checks.map(
    (check) =>
      new CommandDetector({
        id: check.id,
        command: check.command,
        args: check.args ?? [],
        editable: check.editable,
        ...(check.timeoutMs !== undefined ? { timeoutMs: check.timeoutMs } : {}),
      }),
  );

  const ctx: RunContext = {
    repoRoot: config.repoRoot,
    evidenceDir: resolve(config.repoRoot, config.evidenceDir),
    dryRun,
    config: {},
    log,
  };

  const runner = new Runner({
    detectors,
    // Phase 1 ships with the fixer that proposes nothing, so the loop can be run
    // end to end for free. The harness fixer is a one-line swap here — that it is
    // one line is the evidence the `Fixer` boundary was drawn in the right place.
    fixer: new NoopFixer(),
    repo: new GitRepo({ dir: config.repoRoot }),
    ctx,
    allowlist: config.allowlist,
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

  if (values['json'] === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(report.outcomes, report.issues, dryRun));
  }

  if (report.halted) {
    process.stderr.write(`halted: ${report.haltReason}\n`);
    return 3;
  }

  // Exit code carries the outcome so CI can act on it: anything unhealed is a
  // failure, because the point is that the repo ends healthy.
  const unresolved = report.outcomes.filter((o) => o.state !== 'HEALED' && o.state !== 'PROPOSED');
  return unresolved.length > 0 ? 1 : 0;
}

function editableFor(issue: Issue, config: SelfHealConfig): readonly string[] {
  return config.checks.find((check) => check.id === issue.detectorId)?.editable ?? config.allowlist;
}

function formatReport(outcomes: readonly IssueOutcome[], issues: number, dryRun: boolean): string {
  if (issues === 0) return 'no issues detected\n';

  const lines = outcomes.map((outcome) => {
    const marker = { HEALED: '✔', PROPOSED: '·', REVERTED: '✗', ESCALATED: '!' }[outcome.state];
    return `${marker} ${outcome.state.padEnd(9)} ${outcome.issue.kind} [${outcome.issue.signature.slice(0, 8)}] ${outcome.reason}`;
  });

  const healed = outcomes.filter((o) => o.state === 'HEALED').length;
  const summary = dryRun
    ? `${outcomes.length} issue(s) — dry run, nothing written`
    : `${healed}/${outcomes.length} healed`;

  return `${lines.join('\n')}\n\n${summary}\n`;
}

process.exitCode = await main(process.argv.slice(2));
