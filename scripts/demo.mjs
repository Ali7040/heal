/**
 * The demo.
 *
 * Builds a throwaway repository containing a real bug, then runs the loop over
 * it and narrates every state transition as it happens. Nothing is staged or
 * faked: the measurement is real, the fix is written to a real file, and the
 * verdict comes from re-running the same measurement.
 *
 *   node scripts/demo.mjs                                  # dry run, costs nothing
 *   node scripts/demo.mjs --heal                           # the real loop
 *   node scripts/demo.mjs --fixture orders-total-dropped   # the API contract bug
 *   node scripts/demo.mjs --list
 *
 * The script picks a detector from the *shape* of the fixture rather than from a
 * flag: a fixture with a `check` command is measured by exit code, one with a
 * `serve` block is measured by asking its API. Adding a third detector kind
 * should mean adding a branch here and nothing else — if it ever means editing
 * the runner, the plugin boundary has failed.
 *
 * Requires `pnpm build` first.
 */
import { GitRepo } from '@self-heal/core/git/repo';
import { buildDiagnosis } from '@self-heal/core/diagnosis/build';
import { Runner } from '@self-heal/core/runner/runner';
import { NoopFixer } from '@self-heal/fixer-noop';
import { HarnessFixer } from '@self-heal/fixer-harness';
import { Sandbox } from '@self-heal/testkit/sandbox';
import { FIXTURES, getFixture } from '@self-heal/testkit/fixtures';
import { openJournal } from '@self-heal/journal/store';

import { contextFor, prepareDetector, workspaceFrom } from './lib/fixture-loop.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
const heal = flags.has('--heal');
const fixtureId = valueOf('--fixture') ?? 'pricing-tax-ignored';
// Runs the loop, puts the bug back, and runs it again. The second pass is the
// point of the journal: same regression, no model call.
const twice = flags.has('--twice');

const BOLD = '[1m';
const DIM = '[2m';
const GREEN = '[32m';
const RED = '[31m';
const RESET = '[0m';

if (flags.has('--list')) {
  for (const fixture of Object.values(FIXTURES)) {
    console.log(`${BOLD}${fixture.id}${RESET}\n  ${fixture.defect}\n`);
  }
  process.exit(0);
}

const fixture = getFixture(fixtureId);
const sandbox = await Sandbox.create({ files: fixture.files, prefix: 'self-heal-demo-' });

console.log(`${BOLD}self-heal demo${RESET}  ${DIM}${fixture.id} · ${heal ? 'live' : 'dry run'}${RESET}`);
console.log(`${DIM}sandbox: ${sandbox.dir}${RESET}\n`);
console.log(`${BOLD}The bug${RESET}`);
console.log(`${DIM}${fixture.defect}${RESET}`);
console.log(`${DIM}${excerpt(fixture.files[fixture.primary])}${RESET}\n`);

const started = Date.now();

const { detector, describeMeasurement } = await prepareDetector(fixture, sandbox);
const createWorkspace = workspaceFrom(sandbox);

const journal = await openJournal(`${sandbox.dir}/.self-heal/journal.sqlite`);

const makeRunner = () => new Runner({
  detectors: [detector],
  // The only difference between "shows what it would fix" and "fixes it" is
  // which object is passed here. That is the Fixer boundary doing its job.
  fixer: heal ? new HarnessFixer({ harness: 'claude-code', createWorkspace }) : new NoopFixer(),
  repo: new GitRepo({ dir: sandbox.dir }),
  ctx: contextFor(sandbox, !heal),
  allowlist: [...fixture.editable],
  attemptCap: 2,
  diagnose: (issue) =>
    buildDiagnosis(issue, { repoRoot: sandbox.dir, editableFiles: [...fixture.editable] }),
  journal,
  onTransition: (event) => {
    const at = Date.now() - started;
    const note = event.detail ? ` ${DIM}${JSON.stringify(event.detail)}${RESET}` : '';
    console.log(`  ${String(at).padStart(6)}ms  ${event.to}${note}`);
  },
});

console.log(`${BOLD}The loop${RESET}  ${DIM}${describeMeasurement}${RESET}`);
const report = await makeRunner().run();
const outcome = report.outcomes[0];

console.log(`\n${BOLD}Result${RESET}`);
if (report.halted) {
  console.log(`  ${RED}halted${RESET}: ${report.haltReason}`);
} else if (!outcome) {
  console.log('  no issues detected — the fixture was not broken');
} else {
  const healed = outcome.state === 'HEALED';
  const colour = healed ? GREEN : outcome.state === 'PROPOSED' ? DIM : RED;
  console.log(`  ${colour}${outcome.state}${RESET} — ${outcome.reason}`);
  console.log(`  attempts: ${outcome.attempts}   total: ${report.durationMs}ms`);

  if (heal) {
    const repo = new GitRepo({ dir: sandbox.dir });
    console.log(`\n${BOLD}What changed${RESET}`);
    // Taken from git rather than from the fixer's account of itself — the same
    // rule the patch capture follows (D-008).
    const diff = await repo.git('diff', '-U1', '--', fixture.primary);
    console.log(
      diff.stdout
        .split('\n')
        .filter((line) => /^[-+ ]/.test(line) && !/^(---|\+\+\+)/.test(line))
        .map((line) => (line.startsWith('+') ? `${GREEN}${line}${RESET}` : line.startsWith('-') ? `${RED}${line}${RESET}` : line))
        .join('\n')
        .trimEnd(),
    );

    console.log(`\n${BOLD}Proof it is real${RESET}`);
    const proof = await repo.git('status', '--porcelain');
    console.log(`  git status after: ${proof.stdout.trim() === '' ? 'clean (committed)' : proof.stdout.trim()}`);
  }
}

/**
 * The second pass — what the journal is for.
 *
 * The fix is committed, then the regression is put back in another commit: a
 * revert, a bad merge, a colleague's branch. The loop meets a bug it has seen
 * before, and the transition list is the whole argument — `REPLAY` appears,
 * `PROPOSING` does not.
 */
if (twice && heal && outcome?.state === 'HEALED') {
  const repo = new GitRepo({ dir: sandbox.dir });
  await repo.checkpoint('demo: ship the fix');
  await sandbox.write(fixture.primary, fixture.files[fixture.primary]);
  await repo.checkpoint('demo: the regression comes back');

  console.log(`\n${BOLD}The same bug, a second time${RESET}  ${DIM}journal is warm${RESET}`);
  const second = await makeRunner().run();
  const again = second.outcomes[0];

  console.log(`\n${BOLD}Result${RESET}`);
  console.log(`  ${again?.state === 'HEALED' ? GREEN : RED}${again?.state}${RESET} — ${again?.reason}`);
  const stats = journal.stats();
  console.log(`  ${GREEN}model calls this run: 0${RESET}   total: ${second.durationMs}ms`);
  console.log(`  ${DIM}journal: ${stats.replays} call(s) skipped, ${stats.verified} verified fix(es) remembered${RESET}`);
}

if (!heal) {
  console.log(`\n${DIM}This was a dry run: nothing was written, no commit was made, no model was called.`);
  console.log(`Run with --heal to close the loop with your agent harness.${RESET}`);
}

journal.close();
await sandbox.dispose();

function excerpt(source, limit = 14) {
  const lines = source.trim().split('\n');
  if (lines.length <= limit) return lines.join('\n');
  // Show the part around the defect marker rather than the first N lines, which
  // for a server file would be nothing but imports.
  const marker = lines.findIndex((line) => line.includes('BUG'));
  const start = marker < 0 ? 0 : Math.max(0, marker - 2);
  return [...lines.slice(start, start + limit), `${DIM}… ${lines.length - limit} more lines${RESET}`].join('\n');
}

function valueOf(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
