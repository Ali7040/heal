/**
 * The runner's tests are invariant tests, not feature tests.
 *
 * Each one asserts something that must remain true no matter how the loop is
 * refactored: that success is measured, that mutation is recoverable, that an
 * illegal patch never lands, that a broken fixer cannot thrash a repository.
 * They run against real git repositories and real files — the safety guarantees
 * are about the filesystem, so mocking it would test nothing.
 *
 * No model is involved anywhere in this file.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { RunContext } from '../src/contracts/context.js';
import type { Detector } from '../src/contracts/detector.js';
import type { Diagnosis } from '../src/contracts/diagnosis.js';
import type { EscalationReport } from '../src/contracts/escalation.js';
import type { Fixer } from '../src/contracts/fixer.js';
import type { Issue } from '../src/contracts/issue.js';
import type { Patch } from '../src/contracts/patch.js';
import type { JournalPort, RecordedOutcome } from '../src/contracts/journal.js';
import { GitRepo } from '../src/git/repo.js';
import { silentLogger } from '../src/logger.js';
import { Runner, type TransitionEvent } from '../src/runner/runner.js';
import { contentHash } from '../src/safety/base.js';
import { Sandbox } from '@self-heal/testkit/sandbox';

const BROKEN = 'export const value = 1;\n';
const FIXED = 'export const value = 2;\n';
const TEST_FILE = 'assert(value === 2);\n';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  await sandbox?.dispose();
  sandbox = undefined;
});

/**
 * A detector whose health is a single file's contents. Trivial, but it has the
 * one property that matters: `verify` re-reads the file, so it cannot be fooled
 * by anything except the file actually changing.
 */
class FileDetector implements Detector {
  readonly id = 'file';
  constructor(private readonly dir: string) {}

  async #healthy(): Promise<boolean> {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    return (await readFile(join(this.dir, 'src/value.mjs'), 'utf8')) === FIXED;
  }

  async detect(): Promise<Issue[]> {
    if (await this.#healthy()) return [];
    return [
      {
        signature: 'sig-value',
        detectorId: this.id,
        kind: 'wrong-value',
        location: { file: 'src/value.mjs', line: 1 },
        expected: FIXED,
        actual: BROKEN,
        evidence: [],
        severity: 'high',
        detectedAt: new Date().toISOString(),
      },
    ];
  }

  async verify(): Promise<boolean> {
    return this.#healthy();
  }
}

/** Healthy exactly when one file has the expected contents. */
class EqualsDetector implements Detector {
  constructor(
    readonly id: string,
    private readonly dir: string,
    private readonly path: string,
    private readonly expected: string,
  ) {}

  async #healthy(): Promise<boolean> {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    return (await readFile(join(this.dir, this.path), 'utf8')) === this.expected;
  }

  async detect(): Promise<Issue[]> {
    if (await this.#healthy()) return [];
    return [
      {
        signature: `sig-${this.id}`,
        detectorId: this.id,
        kind: 'wrong-contents',
        location: { file: this.path },
        expected: this.expected,
        actual: null,
        evidence: [],
        severity: 'high',
        detectedAt: new Date().toISOString(),
      },
    ];
  }

  async verify(): Promise<boolean> {
    return this.#healthy();
  }
}

/** Two issues from one root cause — both healthy exactly when the file is fixed. */
class TwinDetector extends FileDetector {
  override readonly id = 'twin';
  verifications = 0;

  override async detect(): Promise<Issue[]> {
    const [issue] = await super.detect();
    if (issue === undefined) return [];
    return [
      { ...issue, detectorId: this.id, signature: 'sig-a' },
      { ...issue, detectorId: this.id, signature: 'sig-b' },
    ];
  }

  override async verify(): Promise<boolean> {
    this.verifications += 1;
    return super.verify();
  }
}

async function commitCount(box: Sandbox): Promise<number> {
  return Number((await box.git.git('rev-list', '--count', 'HEAD')).stdout.trim());
}

function fixerReturning(edits: Patch['edits']): Fixer {
  return {
    id: 'stub',
    propose: async (diagnosis) => ({
      fixerId: 'stub',
      signature: diagnosis.issue.signature,
      edits,
      rationale: 'stub',
    }),
  };
}

function contextFor(dir: string, dryRun = false): RunContext {
  return { repoRoot: dir, evidenceDir: `${dir}/.evidence`, dryRun, config: {}, log: silentLogger };
}

async function makeRunner(
  box: Sandbox,
  fixer: Fixer,
  overrides: Partial<ConstructorParameters<typeof Runner>[0]> = {},
) {
  const transitions: TransitionEvent[] = [];
  const detector = new FileDetector(box.dir);
  const ctx = overrides.ctx ?? contextFor(box.dir);

  const runner = new Runner({
    detectors: [detector],
    fixer,
    repo: new GitRepo({ dir: box.dir }),
    ctx,
    allowlist: ['src/**/*.mjs'],
    diagnose: async (issue) => ({ issue, slices: [], editableFiles: ['src/value.mjs'] }),
    onTransition: (event) => transitions.push(event),
    ...overrides,
  });

  return { runner, transitions };
}

function hashOf(text: string): string {
  return contentHash(Buffer.from(text, 'utf8'));
}

function rememberedFix(base: string): Patch {
  return {
    fixerId: 'previous',
    signature: 'sig-value',
    edits: [{ path: 'src/value.mjs', contents: FIXED, base }],
    rationale: 'remembered',
  };
}

async function brokenSandbox(): Promise<Sandbox> {
  return Sandbox.create({ files: { 'src/value.mjs': BROKEN }, prefix: 'runner-test-' });
}

describe('Runner', () => {
  it('heals when the patch makes the original measurement pass', async () => {
    sandbox = await brokenSandbox();
    const { runner, transitions } = await makeRunner(
      sandbox,
      fixerReturning([{ path: 'src/value.mjs', contents: FIXED }]),
    );

    const report = await runner.run();

    expect(report.outcomes[0]?.state).toBe('HEALED');
    expect(await sandbox.read('src/value.mjs')).toBe(FIXED);
    // The route to HEALED went through a real verification step.
    expect(transitions.map((t) => t.to)).toContain('VERIFYING');
  });

  it('checkpoints before it writes anything (invariant 1)', async () => {
    sandbox = await brokenSandbox();
    const { runner, transitions } = await makeRunner(
      sandbox,
      fixerReturning([{ path: 'src/value.mjs', contents: FIXED }]),
    );

    await runner.run();

    const order = transitions.map((t) => t.to);
    expect(order.indexOf('CHECKPOINTING')).toBeLessThan(order.indexOf('APPLYING'));
  });

  it('reverts and never reports healed when verification fails (invariant 2)', async () => {
    sandbox = await brokenSandbox();
    // A patch that writes something plausible but does not satisfy the detector —
    // the exact case where a model would claim success.
    const { runner } = await makeRunner(
      sandbox,
      fixerReturning([{ path: 'src/value.mjs', contents: 'export const value = 999;\n' }]),
    );

    const report = await runner.run();

    expect(report.outcomes[0]?.state).toBe('ESCALATED');
    // The tree is byte-identical to where it started.
    expect(await sandbox.read('src/value.mjs')).toBe(BROKEN);
  });

  it('stops at the attempt cap rather than trying forever (invariant 3)', async () => {
    sandbox = await brokenSandbox();
    let proposals = 0;
    const fixer: Fixer = {
      id: 'counting',
      propose: async (diagnosis) => {
        proposals += 1;
        return { fixerId: 'counting', signature: diagnosis.issue.signature, edits: [], rationale: 'nope' };
      },
    };

    const { runner } = await makeRunner(sandbox, fixer, { attemptCap: 2 });
    const report = await runner.run();

    expect(proposals).toBe(2);
    expect(report.outcomes[0]?.state).toBe('ESCALATED');
  });

  it('tells a retry what already failed, and why, instead of asking the same question twice', async () => {
    sandbox = await brokenSandbox();
    const seen: Diagnosis[] = [];
    const fixer: Fixer = {
      id: 'learning',
      propose: async (diagnosis) => {
        seen.push(diagnosis);
        // Wrong on the first try; right once it has been told the first was wrong.
        const contents = diagnosis.priorAttempts === undefined ? 'export const value = 999;\n' : FIXED;
        return { fixerId: 'learning', signature: diagnosis.issue.signature, edits: [{ path: 'src/value.mjs', contents }], rationale: 'guess' };
      },
    };

    const { runner } = await makeRunner(sandbox, fixer, { attemptCap: 2 });
    const report = await runner.run();

    expect(report.outcomes[0]?.state).toBe('HEALED');
    expect(seen[0]?.priorAttempts).toBeUndefined();
    expect(seen[1]?.priorAttempts).toEqual([
      { files: ['src/value.mjs'], rationale: 'guess', reason: 'verification failed; tree restored' },
    ]);
  });

  it('rejects a patch outside the allowlist before writing it (invariant 4)', async () => {
    sandbox = await brokenSandbox();
    const { runner } = await makeRunner(
      sandbox,
      fixerReturning([
        { path: 'src/value.mjs', contents: FIXED },
        { path: 'package.json', contents: '{"malicious": true}' },
      ]),
    );

    const report = await runner.run();

    expect(report.outcomes[0]?.state).toBe('ESCALATED');
    // Crucially, the *allowed* file was not written either: the gate runs on the
    // whole patch, so a rejected edit cannot leave a half-applied change behind.
    expect(await sandbox.read('src/value.mjs')).toBe(BROKEN);
  });

  it('refuses to run against a dirty working tree (invariant 5)', async () => {
    sandbox = await brokenSandbox();
    await sandbox.write('src/uncommitted.mjs', 'export const scratch = true;\n');

    const { runner } = await makeRunner(sandbox, fixerReturning([{ path: 'src/value.mjs', contents: FIXED }]));
    const report = await runner.run();

    expect(report.halted).toBe(true);
    expect(report.haltReason).toContain('dirty');
    // Nothing ran, so the user's uncommitted work is untouched.
    expect(await sandbox.read('src/uncommitted.mjs')).toBe('export const scratch = true;\n');
  });

  it('writes nothing and commits nothing in a dry run (invariant 7)', async () => {
    sandbox = await brokenSandbox();
    const headBefore = await sandbox.git.currentCommit();

    const { runner, transitions } = await makeRunner(
      sandbox,
      fixerReturning([{ path: 'src/value.mjs', contents: FIXED }]),
      { ctx: contextFor(sandbox.dir, true) },
    );
    const report = await runner.run();

    expect(report.outcomes[0]?.state).toBe('PROPOSED');
    expect(report.outcomes[0]?.reason).toContain('would edit src/value.mjs');
    expect(await sandbox.read('src/value.mjs')).toBe(BROKEN);
    // No checkpoint commit either — a checkpoint is itself a mutation.
    expect(await sandbox.git.currentCommit()).toBe(headBefore);
    expect(transitions.some((t) => t.to === 'APPLYING')).toBe(false);
  });

  it('replays a journalled fix without calling the fixer at all', async () => {
    sandbox = await brokenSandbox();

    const remembered: RecordedOutcome = {
      signature: 'sig-value',
      kind: 'wrong-value',
      patch: rememberedFix(hashOf(BROKEN)),
      verified: true,
      attempts: 1,
    };
    const journal: JournalPort = { lookup: async () => remembered, record: async () => {} };

    let called = false;
    const fixer: Fixer = {
      id: 'should-not-run',
      propose: async (diagnosis) => {
        called = true;
        return { fixerId: 'should-not-run', signature: diagnosis.issue.signature, edits: [], rationale: '' };
      },
    };

    const { runner, transitions } = await makeRunner(sandbox, fixer, { journal });
    const report = await runner.run();

    expect(called).toBe(false);
    expect(report.outcomes[0]?.state).toBe('HEALED');
    expect(report.outcomes[0]?.replayed).toBe(true);
    // Even a replayed patch is verified — a remembered fix is still measured.
    expect(transitions.map((t) => t.to)).toContain('VERIFYING');
  });

  it('records the measured verdict in the journal, not the fixer’s claim', async () => {
    sandbox = await brokenSandbox();
    const recorded: RecordedOutcome[] = [];
    const journal: JournalPort = {
      lookup: async () => undefined,
      record: async (outcome) => void recorded.push(outcome),
    };

    const { runner } = await makeRunner(
      sandbox,
      fixerReturning([{ path: 'src/value.mjs', contents: 'export const value = 3;\n' }]),
      { journal, attemptCap: 1 },
    );
    await runner.run();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.verified).toBe(false);
  });

  it('never lets a patch edit what a detector measures against, whatever the allowlist says (invariant 8)', async () => {
    sandbox = await Sandbox.create({
      files: { 'src/value.mjs': BROKEN, 'src/value.test.mjs': TEST_FILE, '.self-heal/baselines/v.png': 'png' },
      prefix: 'runner-test-',
    });
    // The patch fixes nothing; it rewrites the test and the baseline so the check
    // would pass — the fix a model asked to "make it green" can always find.
    const { runner } = await makeRunner(
      sandbox,
      fixerReturning([
        { path: 'src/value.test.mjs', contents: '' },
        { path: '.self-heal/baselines/v.png', contents: 'forged' },
      ]),
      { allowlist: ['**'], protectedPaths: ['**/*.test.*'], attemptCap: 1 },
    );

    const report = await runner.run();

    expect(report.outcomes[0]?.state).toBe('ESCALATED');
    expect(report.outcomes[0]?.reason).toContain('src/value.test.mjs (protected)');
    expect(report.outcomes[0]?.reason).toContain('.self-heal/baselines/v.png (protected)');
    expect(await sandbox.read('src/value.test.mjs')).toBe(TEST_FILE);
    expect(await sandbox.read('.self-heal/baselines/v.png')).toBe('png');
  });

  it("honours a detector's own protected paths", async () => {
    sandbox = await brokenSandbox();
    const detector = Object.assign(new FileDetector(sandbox.dir), { protectedPaths: () => ['src/**'] });
    const { runner } = await makeRunner(sandbox, fixerReturning([{ path: 'src/value.mjs', contents: FIXED }]), {
      detectors: [detector],
      attemptCap: 1,
    });

    const report = await runner.run();

    expect(report.outcomes[0]?.state).toBe('ESCALATED');
    expect(await sandbox.read('src/value.mjs')).toBe(BROKEN);
  });

  it('refuses to replay a remembered fix onto a file that has changed since (D-020)', async () => {
    // The file today carries unrelated work the remembered fix never saw.
    const edited = `${BROKEN}export const other = 'new work';\n`;
    sandbox = await Sandbox.create({ files: { 'src/value.mjs': edited }, prefix: 'runner-test-' });
    const remembered: RecordedOutcome = {
      signature: 'sig-value',
      kind: 'wrong-value',
      patch: rememberedFix(hashOf(BROKEN)),
      verified: true,
      attempts: 1,
    };
    const journal: JournalPort = { lookup: async () => remembered, record: async () => {} };

    let proposed = false;
    const fixer: Fixer = {
      id: 'fresh',
      propose: async (diagnosis) => {
        proposed = true;
        return { fixerId: 'fresh', signature: diagnosis.issue.signature, edits: [], rationale: 'nothing' };
      },
    };

    const { runner, transitions } = await makeRunner(sandbox, fixer, { journal, attemptCap: 1 });
    await runner.run();

    expect(transitions.map((t) => t.to)).not.toContain('REPLAY');
    expect(proposed).toBe(true);
    // The unrelated work survived. Replaying would have wiped it and still reported HEALED.
    expect(await sandbox.read('src/value.mjs')).toBe(edited);
  });

  it('refuses to replay a remembered fix that never recorded its base', async () => {
    sandbox = await brokenSandbox();
    const remembered: RecordedOutcome = {
      signature: 'sig-value',
      kind: 'wrong-value',
      patch: { fixerId: 'old', signature: 'sig-value', edits: [{ path: 'src/value.mjs', contents: FIXED }], rationale: 'legacy' },
      verified: true,
      attempts: 1,
    };
    const journal: JournalPort = { lookup: async () => remembered, record: async () => {} };
    const { runner, transitions } = await makeRunner(sandbox, fixerReturning([{ path: 'src/value.mjs', contents: FIXED }]), {
      journal,
    });

    const report = await runner.run();

    expect(transitions.map((t) => t.to)).not.toContain('REPLAY');
    // Still healed — by a fresh proposal, which is measured the same way.
    expect(report.outcomes[0]?.state).toBe('HEALED');
    expect(report.outcomes[0]?.replayed).toBe(false);
  });

  it('records the base each fresh edit was made against, so it can be replayed later', async () => {
    sandbox = await brokenSandbox();
    const recorded: RecordedOutcome[] = [];
    const journal: JournalPort = { lookup: async () => undefined, record: async (o) => void recorded.push(o) };
    const { runner } = await makeRunner(sandbox, fixerReturning([{ path: 'src/value.mjs', contents: FIXED }]), { journal });

    await runner.run();

    expect(recorded[0]?.patch.edits[0]?.base).toBe(hashOf(BROKEN));
  });

  it('leaves one named commit per verified fix, and no empty checkpoints (D-023)', async () => {
    sandbox = await brokenSandbox();
    const before = await commitCount(sandbox);
    const { runner } = await makeRunner(sandbox, fixerReturning([{ path: 'src/value.mjs', contents: FIXED }]));

    await runner.run();

    expect(await commitCount(sandbox)).toBe(before + 1);
    const message = (await sandbox.git.git('log', '-1', '--format=%B')).stdout;
    expect(message).toMatch(/^self-heal: fix wrong-value \(sig-valu\)/);
    expect(message).toContain('Verified by re-running detector "file"');
    // Nothing left dirty for a human to wonder about.
    expect(await sandbox.git.isClean()).toBe(true);
  });

  it('leaves history untouched when every attempt fails', async () => {
    sandbox = await brokenSandbox();
    const head = await sandbox.git.currentCommit();
    const { runner } = await makeRunner(
      sandbox,
      fixerReturning([{ path: 'src/value.mjs', contents: 'export const value = 999;\n' }]),
    );

    const report = await runner.run();

    expect(report.outcomes[0]?.state).toBe('ESCALATED');
    expect(await sandbox.git.currentCommit()).toBe(head);
    expect(await sandbox.git.isClean()).toBe(true);
  });

  it('resolves an issue an earlier fix already cured, without a model call (D-022)', async () => {
    sandbox = await brokenSandbox();
    // Two issues, one root cause: both are measured by the same file.
    const detector = new TwinDetector(sandbox.dir);
    let proposals = 0;
    const fixer: Fixer = {
      id: 'counting',
      propose: async (diagnosis) => {
        proposals += 1;
        return { fixerId: 'counting', signature: diagnosis.issue.signature, edits: [{ path: 'src/value.mjs', contents: FIXED }], rationale: 'fix' };
      },
    };
    const { runner } = await makeRunner(sandbox, fixer, { detectors: [detector] });

    const report = await runner.run();

    expect(report.outcomes.map((o) => o.state)).toEqual(['HEALED', 'RESOLVED']);
    expect(proposals).toBe(1);
    // One to confirm the first failure reproduces (D-030), one for the fix, one to
    // find the second issue already gone. No more.
    expect(detector.verifications).toBe(3);
  });

  it('re-measures each failure once before spending on it, and not at all when told not to', async () => {
    sandbox = await brokenSandbox();
    const guarded = new TwinDetector(sandbox.dir);
    const { runner } = await makeRunner(sandbox, fixerReturning([]), { detectors: [guarded] });

    expect((await runner.run()).outcomes.map((o) => o.state)).toEqual(['ESCALATED', 'ESCALATED']);
    // One confirmation per issue; nothing was applied, so nothing else re-measured.
    expect(guarded.verifications).toBe(2);

    const trusting = new TwinDetector(sandbox.dir);
    const { runner: unguarded } = await makeRunner(sandbox, fixerReturning([]), {
      detectors: [trusting],
      confirmFailures: 0,
    });
    await unguarded.run();
    expect(trusting.verifications).toBe(0);
  });

  describe('flake guard (D-030)', () => {
    /** Fails its first `failures` measurements, then passes — with nothing changed. */
    class FlakyDetector extends FileDetector {
      override readonly id = 'flaky';
      measurements = 0;
      constructor(
        dir: string,
        private readonly failures: number,
      ) {
        super(dir);
      }
      override async detect(): Promise<Issue[]> {
        this.measurements += 1;
        const [issue] = await super.detect();
        return this.measurements <= this.failures && issue !== undefined ? [{ ...issue, detectorId: this.id }] : [];
      }
      override async verify(): Promise<boolean> {
        this.measurements += 1;
        return this.measurements > this.failures;
      }
    }

    function refusingFixer(): Fixer & { calls: number } {
      const fixer = {
        id: 'never',
        calls: 0,
        propose: async (diagnosis: Diagnosis) => {
          fixer.calls += 1;
          return { fixerId: 'never', signature: diagnosis.issue.signature, edits: [], rationale: '' };
        },
      };
      return fixer;
    }

    it('reports a failure that does not reproduce as FLAKY, and spends nothing on it', async () => {
      sandbox = await brokenSandbox();
      const fixer = refusingFixer();
      const { runner } = await makeRunner(sandbox, fixer, { detectors: [new FlakyDetector(sandbox.dir, 1)] });

      const report = await runner.run();

      expect(report.outcomes[0]?.state).toBe('FLAKY');
      expect(report.outcomes[0]?.reason).toContain('flaky');
      expect(fixer.calls).toBe(0);
      expect(await sandbox.git.isClean()).toBe(true);
    });

    it('re-runs as many times as configured before calling it real', async () => {
      sandbox = await brokenSandbox();
      // Fails the detection and the first re-run, passes the second.
      const fixer = refusingFixer();
      const twice = new FlakyDetector(sandbox.dir, 2);
      const { runner: once } = await makeRunner(sandbox, fixer, { detectors: [twice], attemptCap: 1 });
      expect((await once.run()).outcomes[0]?.state).toBe('ESCALATED');
      expect(fixer.calls).toBe(1);

      const again = new FlakyDetector(sandbox.dir, 2);
      const { runner: patient } = await makeRunner(sandbox, refusingFixer(), { detectors: [again], confirmFailures: 2 });
      expect((await patient.run()).outcomes[0]?.state).toBe('FLAKY');
    });

    it('does not revert a good fix because some other check flaked', async () => {
      sandbox = await Sandbox.create({
        files: { 'src/value.mjs': BROKEN, 'src/other.mjs': 'ok\n' },
        prefix: 'runner-test-',
      });
      // Healthy at detection; flakes once during the collateral check; then passes.
      let runs = 0;
      const shaky: Detector = {
        id: 'shaky',
        detect: async () => {
          runs += 1;
          return runs === 2
            ? [{ signature: 'sig-shaky', detectorId: 'shaky', kind: 'flake', location: {}, expected: 0, actual: 1, evidence: [], severity: 'low', detectedAt: '' }]
            : [];
        },
        verify: async () => true,
      };
      const { runner } = await makeRunner(sandbox, fixerReturning([{ path: 'src/value.mjs', contents: FIXED }]), {
        detectors: [new FileDetector(sandbox.dir), shaky],
      });

      const report = await runner.run();

      expect(report.outcomes[0]?.state).toBe('HEALED');
      expect(await sandbox.read('src/value.mjs')).toBe(FIXED);
    });
  });

  describe('collateral check (D-025)', () => {
    const OTHER_OK = 'export const other = true;\n';
    const OTHER_BROKEN = 'export const other = false;\n';

    async function twoFileSandbox(other = OTHER_OK): Promise<Sandbox> {
      return Sandbox.create({ files: { 'src/value.mjs': BROKEN, 'src/other.mjs': other }, prefix: 'runner-test-' });
    }

    function bothDetectors(box: Sandbox): Detector[] {
      return [new FileDetector(box.dir), new EqualsDetector('other', box.dir, 'src/other.mjs', OTHER_OK)];
    }

    it('reverts a fix that passes its own check but breaks another', async () => {
      sandbox = await twoFileSandbox();
      const box = sandbox;
      const { runner } = await makeRunner(
        box,
        fixerReturning([
          { path: 'src/value.mjs', contents: FIXED },
          { path: 'src/other.mjs', contents: OTHER_BROKEN },
        ]),
        { detectors: bothDetectors(box), attemptCap: 1 },
      );

      const report = await runner.run();

      expect(report.outcomes[0]?.state).toBe('ESCALATED');
      expect(report.outcomes[0]?.reason).toContain('broke other (wrong-contents at src/other.mjs)');
      expect(await box.read('src/value.mjs')).toBe(BROKEN);
      expect(await box.read('src/other.mjs')).toBe(OTHER_OK);
    });

    it('tells the retry what the first attempt broke', async () => {
      sandbox = await twoFileSandbox();
      const box = sandbox;
      const seen: Diagnosis[] = [];
      const fixer: Fixer = {
        id: 'learns',
        propose: async (diagnosis) => {
          seen.push(diagnosis);
          const careless = diagnosis.priorAttempts === undefined;
          return {
            fixerId: 'learns',
            signature: diagnosis.issue.signature,
            edits: [
              { path: 'src/value.mjs', contents: FIXED },
              ...(careless ? [{ path: 'src/other.mjs', contents: OTHER_BROKEN }] : []),
            ],
            rationale: careless ? 'rewrite both' : 'only the value',
          };
        },
      };
      const { runner } = await makeRunner(box, fixer, { detectors: bothDetectors(box) });

      const report = await runner.run();

      expect(report.outcomes[0]?.state).toBe('HEALED');
      expect(seen[1]?.priorAttempts?.[0]?.reason).toContain('broke other');
    });

    it('does not blame a fix for a check that was already failing', async () => {
      sandbox = await twoFileSandbox(OTHER_BROKEN);
      const box = sandbox;
      const { runner } = await makeRunner(box, fixerReturning([{ path: 'src/value.mjs', contents: FIXED }]), {
        detectors: bothDetectors(box),
        attemptCap: 1,
      });

      const report = await runner.run();

      // The first issue heals despite the second still failing; the second's own
      // proposal does not fix it and escalates on its own merits.
      expect(report.outcomes.map((o) => o.state)).toEqual(['HEALED', 'ESCALATED']);
    });

    it('catches a later fix re-breaking something healed earlier in the run', async () => {
      sandbox = await twoFileSandbox(OTHER_BROKEN);
      const box = sandbox;
      const fixer: Fixer = {
        id: 'clumsy',
        propose: async (diagnosis) => ({
          fixerId: 'clumsy',
          signature: diagnosis.issue.signature,
          edits:
            diagnosis.issue.detectorId === 'file'
              ? [{ path: 'src/value.mjs', contents: FIXED }]
              : // Fixes "other" by putting the first bug back.
                [
                  { path: 'src/other.mjs', contents: OTHER_OK },
                  { path: 'src/value.mjs', contents: BROKEN },
                ],
          rationale: 'clumsy',
        }),
      };
      const { runner } = await makeRunner(box, fixer, { detectors: bothDetectors(box), attemptCap: 1 });

      const report = await runner.run();

      expect(report.outcomes.map((o) => o.state)).toEqual(['HEALED', 'ESCALATED']);
      expect(report.outcomes[1]?.reason).toContain('broke file');
      expect(await box.read('src/value.mjs')).toBe(FIXED);
    });

    it('counts a detector that cannot run against the patch as broken', async () => {
      sandbox = await brokenSandbox();
      const box = sandbox;
      let runs = 0;
      const fragile: Detector = {
        id: 'fragile',
        detect: async () => {
          runs += 1;
          if (runs > 1) throw new Error('server would not boot');
          return [];
        },
        verify: async () => true,
      };
      const { runner } = await makeRunner(box, fixerReturning([{ path: 'src/value.mjs', contents: FIXED }]), {
        detectors: [new FileDetector(box.dir), fragile],
        attemptCap: 1,
      });

      const report = await runner.run();

      expect(report.outcomes[0]?.state).toBe('ESCALATED');
      expect(report.outcomes[0]?.reason).toContain('fragile (could not run: server would not boot)');
      expect(await box.read('src/value.mjs')).toBe(BROKEN);
    });

    it('can be switched off, trading the guarantee for one less detection per heal', async () => {
      sandbox = await twoFileSandbox();
      const box = sandbox;
      const { runner } = await makeRunner(
        box,
        fixerReturning([
          { path: 'src/value.mjs', contents: FIXED },
          { path: 'src/other.mjs', contents: OTHER_BROKEN },
        ]),
        { detectors: bothDetectors(box), collateralCheck: false },
      );

      const report = await runner.run();

      expect(report.outcomes[0]?.state).toBe('HEALED');
    });
  });

  describe('escalation hand-off (D-028)', () => {
    it('hands over every attempt, with the diff each one applied and why it failed', async () => {
      sandbox = await brokenSandbox();
      const box = sandbox;
      const reports: EscalationReport[] = [];
      let tries = 0;
      const fixer: Fixer = {
        id: 'wrong',
        propose: async (diagnosis) => {
          tries += 1;
          return {
            fixerId: 'wrong',
            signature: diagnosis.issue.signature,
            // The second attempt also creates a file — it must show up in the diff.
            edits: [
              { path: 'src/value.mjs', contents: `export const value = ${tries * 100};\n` },
              ...(tries === 2 ? [{ path: 'src/helper.mjs', contents: 'export const h = 1;\n' }] : []),
            ],
            rationale: `guess ${tries}`,
          };
        },
      };
      const { runner } = await makeRunner(box, fixer, { onEscalate: (report) => void reports.push(report) });

      await runner.run();

      expect(reports).toHaveLength(1);
      const [report] = reports;
      expect(report?.reason).toMatch(/^attempt cap reached/);
      expect(report?.diagnosis?.editableFiles).toEqual(['src/value.mjs']);
      expect(report?.attempts.map((a) => [a.number, a.rationale, a.reason])).toEqual([
        [1, 'guess 1', 'verification failed; tree restored'],
        [2, 'guess 2', 'verification failed; tree restored'],
      ]);
      expect(report?.attempts[0]?.diff).toContain('+export const value = 100;');
      expect(report?.attempts[1]?.diff).toContain('+export const h = 1;');
      // Taking the diff must not leave anything behind: the restore still restores.
      expect(await box.git.isClean()).toBe(true);
      expect(await box.read('src/value.mjs')).toBe(BROKEN);
    });

    it('records a rejected attempt without a diff — it never touched the tree', async () => {
      sandbox = await brokenSandbox();
      const reports: EscalationReport[] = [];
      const { runner } = await makeRunner(sandbox, fixerReturning([{ path: 'elsewhere.mjs', contents: 'x' }]), {
        attemptCap: 1,
        onEscalate: (report) => void reports.push(report),
      });

      await runner.run();

      expect(reports[0]?.attempts[0]?.reason).toContain('elsewhere.mjs (not-allowed)');
      expect(reports[0]?.attempts[0]?.diff).toBeUndefined();
    });

    it('still escalates when writing the report fails', async () => {
      sandbox = await brokenSandbox();
      const { runner } = await makeRunner(sandbox, fixerReturning([]), {
        attemptCap: 1,
        onEscalate: () => {
          throw new Error('disk full');
        },
      });

      const report = await runner.run();

      expect(report.outcomes[0]?.state).toBe('ESCALATED');
    });
  });

  it('does nothing at all when there is nothing to detect', async () => {
    sandbox = await Sandbox.create({ files: { 'src/value.mjs': FIXED }, prefix: 'runner-test-' });

    let called = false;
    const fixer: Fixer = {
      id: 'never',
      propose: async (diagnosis) => {
        called = true;
        return { fixerId: 'never', signature: diagnosis.issue.signature, edits: [], rationale: '' };
      },
    };

    const { runner } = await makeRunner(sandbox, fixer);
    const report = await runner.run();

    // The common case is a healthy repo, and it must cost nothing.
    expect(report.issues).toBe(0);
    expect(called).toBe(false);
  });
});
