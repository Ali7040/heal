/**
 * Harness probe — the experiment that answers D-005 with evidence.
 *
 * It builds a disposable repository containing a real bug, measures it, asks a
 * harness to fix it, and measures again. Two capture strategies run against
 * identical sandboxes so the choice between them is decided by results rather
 * than by argument:
 *
 *   ask-for-diff  the model is read-only and must PRINT a unified diff, which
 *                 we would then have to parse and apply.
 *   edit-capture  the model edits the sandbox and we read the change out of git.
 *
 * This is not a test — it costs money and needs a logged-in harness, so it must
 * never run in the suite (AGENTS.md). It is a repeatable diagnostic: run it again
 * whenever a harness ships a new version and the assumptions may have moved.
 *
 *   pnpm build && node scripts/harness-probe.mjs [--harness=claude-code]
 *                                                [--fixture=pricing-tax-ignored]
 *                                                [--strategy=both|ask-for-diff|edit-capture]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { GitRepo } from '@self-heal/core/git/repo';
import { Sandbox } from '@self-heal/testkit/sandbox';
import { getFixture } from '@self-heal/testkit/fixtures';
import { measure } from '@self-heal/testkit/measure';
import { capturePatch } from '@self-heal/fixer-harness/capture';
import { invokeHarness } from '@self-heal/fixer-harness/invoke';
import { getProfile } from '@self-heal/fixer-harness/profiles';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v = 'true'] = a.slice(2).split('=');
      return [k, v];
    }),
);

const harnessId = args.harness ?? 'claude-code';
const fixtureId = args.fixture ?? 'pricing-tax-ignored';
const strategy = args.strategy ?? 'both';

/**
 * Strategy A: the model may only read. It has to produce the patch as text.
 * We measure whether the output is even shaped like a diff — before worrying
 * about whether it is correct.
 */
async function askForDiff(fixture, sandbox, failure) {
  const prompt = [
    `A deterministic check is failing: ${fixture.defect}`,
    '',
    'Check output:',
    failure.output,
    '',
    'Read the source and output a unified diff that fixes it.',
    'Output ONLY the diff, starting with "--- a/". No prose, no code fences.',
    'Do not modify any files.',
  ].join('\n');

  const run = await invokeHarness({
    profile: getProfile(harnessId),
    prompt,
    cwd: sandbox.dir,
    allowTools: ['Read'],
    denyTools: ['Edit', 'Write', 'Bash'],
  });

  const text = run.summary?.text ?? '';
  return {
    invocation: run,
    // Both checks are generous on purpose: even a fenced or prose-wrapped diff
    // counts as "produced something", so the comparison is not rigged.
    producedDiffText: /(^|\n)(---|diff --git|@@)/.test(text),
    diffLength: text.length,
    // Nothing was allowed to change, so the fix cannot have been applied.
    filesChanged: (await sandbox.git.changes()).length,
  };
}

/**
 * Strategy B: the model edits the sandbox; git tells us what happened.
 * The model's reply is never consulted about what changed.
 */
async function editCapture(fixture, sandbox, failure) {
  const prompt = [
    `A deterministic check is failing: ${fixture.defect}`,
    '',
    'Check output:',
    failure.output,
    '',
    `Fix the cause. Edit only: ${fixture.editable.join(', ')}`,
    'Do not modify check.mjs. Do not create new files. Do not run git.',
  ].join('\n');

  const run = await invokeHarness({
    profile: getProfile(harnessId),
    prompt,
    cwd: sandbox.dir,
  });

  const captured = await capturePatch({
    repo: new GitRepo({ dir: sandbox.dir }),
    fixerId: 'probe',
    signature: 'probe-signature',
    rationale: 'harness probe',
  });

  return {
    invocation: run,
    patchEdits: captured.patch.edits.map((edit) => edit.path),
    deleted: captured.deleted,
    empty: captured.empty,
    diffLength: captured.diff.length,
    diff: captured.diff,
  };
}

async function runStrategy(name, fixture) {
  const sandbox = await Sandbox.create({ files: fixture.files, prefix: 'self-heal-probe-' });

  try {
    // Detect. If the fixture is not broken to begin with, the run proves nothing.
    const before = await measure(fixture, sandbox.dir);
    if (before.healthy) throw new Error(`fixture "${fixture.id}" is not broken — probe is meaningless`);

    const detail =
      name === 'ask-for-diff'
        ? await askForDiff(fixture, sandbox, before)
        : await editCapture(fixture, sandbox, before);

    // Verify. The identical measurement, re-run. This is the only thing that
    // decides whether the attempt worked.
    const after = await measure(fixture, sandbox.dir);

    return {
      strategy: name,
      brokenBefore: !before.healthy,
      healthyAfter: after.healthy,
      healed: !before.healthy && after.healthy,
      wallClockMs: detail.invocation.durationMs,
      costUsd: detail.invocation.summary?.costUsd ?? null,
      turns: detail.invocation.summary?.turns ?? null,
      harnessOk: detail.invocation.ok,
      harnessFailure: detail.invocation.failure,
      stderr: detail.invocation.stderr.slice(0, 300),
      ...detail,
      invocation: undefined,
    };
  } finally {
    await sandbox.dispose();
  }
}

const fixture = getFixture(fixtureId);
const strategies = strategy === 'both' ? ['ask-for-diff', 'edit-capture'] : [strategy];

const report = {
  startedAt: new Date().toISOString(),
  harness: harnessId,
  fixture: fixture.id,
  runs: [],
};

for (const name of strategies) {
  process.stderr.write(`running ${name}...\n`);
  report.runs.push(await runStrategy(name, fixture));
}

// Print before writing: a probe run costs real money, so its result must never
// be lost to a bad --out path.
const json = JSON.stringify(report, null, 2);
console.log(json);
if (args.out) {
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, json, 'utf8');
}
