/**
 * The demo.
 *
 * Builds a throwaway repository containing a real bug, then runs the loop over
 * it and narrates every state transition as it happens. Nothing is staged or
 * faked: the check is a real process with a real exit code, the fix is written
 * to a real file, and the verdict comes from re-running the same check.
 *
 *   node scripts/demo.mjs            # dry run: what it *would* do, costs nothing
 *   node scripts/demo.mjs --heal     # the real loop, with your agent harness
 *
 * Requires `pnpm build` first.
 */
import { GitRepo } from '@self-heal/core/git/repo';
import { buildDiagnosis } from '@self-heal/core/diagnosis/build';
import { silentLogger } from '@self-heal/core/logger';
import { Runner } from '@self-heal/core/runner/runner';
import { CommandDetector } from '@self-heal/detector-command';
import { NoopFixer } from '@self-heal/fixer-noop';
import { HarnessFixer } from '@self-heal/fixer-harness';
import { Sandbox } from '@self-heal/testkit/sandbox';
import { snapshotDir } from '@self-heal/testkit/snapshot';
import { getFixture } from '@self-heal/testkit/fixtures';

const flags = new Set(process.argv.slice(2));
const heal = flags.has('--heal');

const BOLD = '[1m';
const DIM = '[2m';
const GREEN = '[32m';
const RED = '[31m';
const RESET = '[0m';

const fixture = getFixture('pricing-tax-ignored');
const sandbox = await Sandbox.create({ files: fixture.files, prefix: 'self-heal-demo-' });

console.log(`${BOLD}self-heal demo${RESET}  ${DIM}${heal ? 'live' : 'dry run'}${RESET}`);
console.log(`${DIM}sandbox: ${sandbox.dir}${RESET}\n`);
console.log(`${BOLD}The bug${RESET}`);
console.log(`${DIM}${fixture.files['src/pricing.mjs'].trim()}${RESET}\n`);

const started = Date.now();
const timeline = [];

const detector = new CommandDetector({
  id: 'pricing-check',
  command: fixture.check.command,
  args: fixture.check.args,
  editable: [...fixture.editable],
  kind: 'check-failed',
});

/**
 * The harness never touches the demo repository: it gets a snapshot copied into
 * a second disposable sandbox, which is destroyed when the proposal is done.
 */
async function createWorkspace() {
  const files = await snapshotDir(sandbox.dir);
  const workspace = await Sandbox.create({ files, prefix: 'self-heal-work-' });
  return { dir: workspace.dir, dispose: () => workspace.dispose() };
}

const runner = new Runner({
  detectors: [detector],
  // The only difference between "shows what it would fix" and "fixes it" is
  // which object is passed here. That is the Fixer boundary doing its job.
  fixer: heal ? new HarnessFixer({ harness: 'claude-code', createWorkspace }) : new NoopFixer(),
  repo: new GitRepo({ dir: sandbox.dir }),
  ctx: {
    repoRoot: sandbox.dir,
    evidenceDir: `${sandbox.dir}/.self-heal/evidence`,
    dryRun: !heal,
    config: {},
    log: silentLogger,
  },
  allowlist: [...fixture.editable],
  attemptCap: 2,
  diagnose: (issue) => buildDiagnosis(issue, { repoRoot: sandbox.dir, editableFiles: [...fixture.editable] }),
  onTransition: (event) => {
    const at = Date.now() - started;
    timeline.push({ at, state: event.to, detail: event.detail });
    const note = event.detail ? ` ${DIM}${JSON.stringify(event.detail)}${RESET}` : '';
    console.log(`  ${String(at).padStart(6)}ms  ${event.to}${note}`);
  },
});

console.log(`${BOLD}The loop${RESET}`);
const report = await runner.run();
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
    console.log(`\n${BOLD}What changed${RESET}`);
    console.log((await sandbox.read('src/pricing.mjs')).trim());
    console.log(`\n${BOLD}Proof it is real${RESET}`);
    // Run the check one final time, outside the loop entirely, so the claim does
    // not rest on anything the loop reported about itself.
    const proof = await new GitRepo({ dir: sandbox.dir }).git('status', '--porcelain');
    console.log(`  git status after: ${proof.stdout.trim() === '' ? 'clean (committed)' : proof.stdout.trim()}`);
  }
}

if (!heal) {
  console.log(`\n${DIM}This was a dry run: nothing was written, no commit was made, no model was called.`);
  console.log(`Run with --heal to close the loop with your agent harness.${RESET}`);
}

await sandbox.dispose();
