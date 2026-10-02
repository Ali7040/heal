/**
 * The benchmark: does the loop actually get cheaper and better?
 *
 * Every fixture, N cold runs each, through the real loop. Each run gets a fresh
 * repository and no journal — a replay costs nothing and measures nothing, so
 * the journal would only hide the model path this exists to measure (D-026).
 *
 *   pnpm bench                            # free: the loop with the noop fixer
 *   pnpm bench:live                       # real harness calls — costs money
 *   node scripts/bench.mjs --live --runs 5 --fixture pricing-tax-ignored
 *   node scripts/bench.mjs --compare .self-heal/bench/<earlier>.json
 *
 * A dry run still measures the one cost this project controls on its own: the
 * size of the prompt each fixture produces. A live run adds heal rate, attempts,
 * model calls and dollars per heal, and wall time.
 *
 * Results go to `.self-heal/bench/` as JSON so two runs — before and after a
 * change — can be compared with `--compare`. Not part of `pnpm test`: a live
 * run calls a model, and the suite never does (AGENTS.md).
 *
 * Requires `pnpm build` first.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildDiagnosis } from '@self-heal/core/diagnosis/build';
import { GitRepo } from '@self-heal/core/git/repo';
import { Runner } from '@self-heal/core/runner/runner';
import { HarnessFixer, buildPrompt } from '@self-heal/fixer-harness';
import { NoopFixer } from '@self-heal/fixer-noop';
import { compare, formatComparison, formatSummary, summarizeAll } from '@self-heal/testkit/bench';
import { FIXTURES, getFixture } from '@self-heal/testkit/fixtures';
import { Sandbox } from '@self-heal/testkit/sandbox';

import { contextFor, prepareDetector, workspaceFrom } from './lib/fixture-loop.mjs';

const argv = process.argv.slice(2);
const live = argv.includes('--live');
const runs = Number(valueOf('--runs') ?? (live ? 3 : 1));
const harness = valueOf('--harness') ?? 'claude-code';
const comparePath = valueOf('--compare');
const fixtureIds = valuesOf('--fixture');
const fixtures = (fixtureIds.length > 0 ? fixtureIds : Object.keys(FIXTURES)).map(getFixture);

if (!Number.isInteger(runs) || runs < 1) {
  console.error('--runs must be a positive integer');
  process.exit(2);
}

const startedAt = new Date().toISOString();
console.log(
  `self-heal bench  ${live ? `live · ${harness}` : 'dry · no model calls'} · ` +
    `${fixtures.length} fixture(s) × ${runs} run(s)\n`,
);

const results = [];
for (const fixture of fixtures) {
  for (let run = 1; run <= runs; run += 1) {
    const result = await benchOnce(fixture, run);
    results.push(result);
    const cost = result.costUsd === null ? '$?' : `$${result.costUsd.toFixed(4)}`;
    console.log(
      `  ${fixture.id} #${run}  ${result.state.padEnd(9)} attempts ${result.attempts}  ` +
        `${(result.durationMs / 1000).toFixed(1)}s  ${cost}  ${result.reason}`,
    );
  }
}

const { summary, total } = summarizeAll(results);
const report = { version: 1, startedAt, harness, dry: !live, runsPerFixture: runs, runs: results, summary, total };

const outDir = join(process.cwd(), '.self-heal', 'bench');
await mkdir(outDir, { recursive: true });
const outPath = valueOf('--out') ?? join(outDir, `${startedAt.replace(/[:.]/g, '-')}-${live ? 'live' : 'dry'}.json`);
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`\n${formatSummary([...summary, total])}\n`);
console.log(`saved: ${outPath}`);

if (comparePath !== undefined) {
  const before = JSON.parse(await readFile(comparePath, 'utf8'));
  if (before.dry !== report.dry) {
    console.log('\nnote: comparing a dry run with a live one — only prompt size is comparable.');
  }
  console.log(`\nagainst ${comparePath}\n\n${formatComparison(compare(before, report))}`);
}

/** One cold run of the loop over one fixture. Never throws: an error is a result. */
async function benchOnce(fixture, run) {
  const sandbox = await Sandbox.create({ files: fixture.files, prefix: 'self-heal-bench-' });
  const calls = [];
  const dryPrompts = [];

  try {
    const { detector } = await prepareDetector(fixture, sandbox);
    const fixer = live
      ? new HarnessFixer({ harness, createWorkspace: workspaceFrom(sandbox), onInvoke: (call) => calls.push(call) })
      : new NoopFixer();

    const runner = new Runner({
      detectors: [detector],
      fixer,
      repo: new GitRepo({ dir: sandbox.dir }),
      ctx: contextFor(sandbox, !live),
      allowlist: [...fixture.editable],
      attemptCap: 2,
      diagnose: async (issue) => {
        const diagnosis = await buildDiagnosis(issue, { repoRoot: sandbox.dir, editableFiles: [...fixture.editable] });
        // A dry run calls no harness, so measure the prompt it would have been sent.
        if (!live) dryPrompts.push(Buffer.byteLength(buildPrompt(diagnosis), 'utf8'));
        return diagnosis;
      },
    });

    const result = await runner.run();
    const outcome = result.outcomes[0];
    const costs = calls.map((call) => call.costUsd);

    return {
      fixture: fixture.id,
      run,
      state: result.halted ? 'HALTED' : (outcome?.state ?? 'NO-ISSUE'),
      healed: outcome?.state === 'HEALED',
      attempts: outcome?.attempts ?? 0,
      durationMs: result.durationMs,
      modelCalls: calls.length,
      // No calls is a true $0; a call that did not report its cost is unknown.
      costUsd: costs.some((cost) => cost === null) ? null : costs.reduce((a, b) => a + b, 0),
      promptBytes: live ? calls.map((call) => call.promptBytes) : dryPrompts,
      harnessFailures: calls.filter((call) => !call.ok).map((call) => call.failure ?? 'unknown'),
      reason: result.halted ? (result.haltReason ?? 'halted') : (outcome?.reason ?? 'the fixture was not broken'),
    };
  } catch (error) {
    return {
      fixture: fixture.id,
      run,
      state: 'ERROR',
      healed: false,
      attempts: 0,
      durationMs: 0,
      modelCalls: calls.length,
      costUsd: null,
      promptBytes: [],
      harnessFailures: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await sandbox.dispose();
  }
}

function valueOf(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function valuesOf(name) {
  return argv.flatMap((arg, index) => (arg === name && argv[index + 1] !== undefined ? [argv[index + 1]] : []));
}
