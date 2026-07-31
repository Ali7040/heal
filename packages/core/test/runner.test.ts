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
import type { Fixer } from '../src/contracts/fixer.js';
import type { Issue } from '../src/contracts/issue.js';
import type { Patch } from '../src/contracts/patch.js';
import type { JournalPort, RecordedOutcome } from '../src/contracts/journal.js';
import { GitRepo } from '../src/git/repo.js';
import { silentLogger } from '../src/logger.js';
import { Runner, type TransitionEvent } from '../src/runner/runner.js';
import { Sandbox } from '@self-heal/testkit/sandbox';

const BROKEN = 'export const value = 1;\n';
const FIXED = 'export const value = 2;\n';

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
      patch: { fixerId: 'previous', signature: 'sig-value', edits: [{ path: 'src/value.mjs', contents: FIXED }], rationale: 'remembered' },
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
