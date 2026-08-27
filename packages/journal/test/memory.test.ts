/**
 * The phase-4 deliverable, stated as a test: the second occurrence of a known
 * regression skips the model entirely.
 *
 * Everything here is real — a real git sandbox, a real detector re-reading a real
 * file, a real SQLite file on disk. The fixer is a counter, because the assertion
 * that matters is *how many times it was asked*, and a counter can prove that
 * where a model never could.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RunContext } from '@self-heal/core/contracts/context';
import type { Detector } from '@self-heal/core/contracts/detector';
import type { Fixer } from '@self-heal/core/contracts/fixer';
import type { Issue } from '@self-heal/core/contracts/issue';
import type { Patch } from '@self-heal/core/contracts/patch';
import { GitRepo } from '@self-heal/core/git/repo';
import { silentLogger } from '@self-heal/core/logger';
import { Runner } from '@self-heal/core/runner/runner';
import { IGNORED_ARTIFACTS } from '@self-heal/testkit/fixtures';
import { Sandbox } from '@self-heal/testkit/sandbox';
import { afterEach, describe, expect, it } from 'vitest';

import { openJournal, type Journal } from '../src/store.js';

/**
 * The journal lives inside the repository it remembers, so it has to be ignored
 * or it dirties the tree and invariant 5 halts the *next* run. `self-heal init`
 * writes this entry for real projects; a sandbox has to do it itself. Not
 * incidental test setup — the requirement, pinned.
 */
const GITIGNORE = IGNORED_ARTIFACTS;

const BROKEN = 'export const rate = 0;\n';
const FIXED = 'export const rate = 0.2;\n';
const FILE = 'src/rate.mjs';

let sandbox: Sandbox | undefined;
let journal: Journal | undefined;

afterEach(async () => {
  journal?.close();
  journal = undefined;
  await sandbox?.dispose();
  sandbox = undefined;
});

/** Health is one file's contents, re-read every time. Nothing else can fool it. */
class FileDetector implements Detector {
  readonly id = 'rate';
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async #healthy(): Promise<boolean> {
    return (await readFile(join(this.#dir, FILE), 'utf8')) === FIXED;
  }

  async detect(): Promise<Issue[]> {
    if (await this.#healthy()) return [];
    return [
      {
        signature: 'sig-rate',
        detectorId: this.id,
        kind: 'wrong-value',
        location: { file: FILE, line: 1 },
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

class CountingFixer implements Fixer {
  readonly id = 'counting';
  calls = 0;

  async propose(): Promise<Patch> {
    this.calls += 1;
    return {
      fixerId: this.id,
      signature: 'sig-rate',
      edits: [{ path: FILE, contents: FIXED }],
      rationale: 'apply the rate',
    };
  }
}

async function runOnce(dir: string, fixer: Fixer, memory: Journal) {
  const ctx: RunContext = {
    repoRoot: dir,
    evidenceDir: join(dir, '.self-heal/evidence'),
    dryRun: false,
    config: {},
    log: silentLogger,
  };

  const runner = new Runner({
    detectors: [new FileDetector(dir)],
    fixer,
    repo: new GitRepo({ dir }),
    ctx,
    journal: memory,
    allowlist: ['src/**'],
    attemptCap: 2,
    diagnose: async (issue: Issue) => ({ issue, slices: [], editableFiles: [FILE] }),
  });

  return runner.run();
}

describe('a journal across two runs', () => {
  it('replays a verified fix without calling the fixer a second time', async () => {
    sandbox = await Sandbox.create({ files: { [FILE]: BROKEN, '.gitignore': GITIGNORE }, prefix: 'self-heal-memory-' });
    journal = await openJournal(join(sandbox.dir, '.self-heal', 'journal.sqlite'));
    const fixer = new CountingFixer();

    const first = await runOnce(sandbox.dir, fixer, journal);
    expect(first.outcomes[0]?.state).toBe('HEALED');
    expect(first.outcomes[0]?.replayed).toBe(false);
    expect(fixer.calls).toBe(1);

    // The regression comes back — a revert, a bad merge, a colleague's branch.
    await writeFile(join(sandbox.dir, FILE), BROKEN, 'utf8');

    const second = await runOnce(sandbox.dir, fixer, journal);
    expect(second.outcomes[0]?.state).toBe('HEALED');
    expect(second.outcomes[0]?.replayed).toBe(true);
    // The whole phase, in one assertion: still one model call, two heals.
    expect(fixer.calls).toBe(1);
    expect(journal.stats().replays).toBe(1);
  });

  it('remembers across process boundaries, not just within one run', async () => {
    sandbox = await Sandbox.create({ files: { [FILE]: BROKEN, '.gitignore': GITIGNORE }, prefix: 'self-heal-memory-' });
    const path = join(sandbox.dir, '.self-heal', 'journal.sqlite');
    const fixer = new CountingFixer();

    const first = await openJournal(path);
    await runOnce(sandbox.dir, fixer, first);
    first.close();

    await writeFile(join(sandbox.dir, FILE), BROKEN, 'utf8');

    // A fresh handle on the same file, as the next `self-heal run` would open it.
    journal = await openJournal(path);
    const second = await runOnce(sandbox.dir, fixer, journal);

    expect(second.outcomes[0]?.state).toBe('HEALED');
    expect(fixer.calls).toBe(1);
  });

  it('falls back to a fresh proposal when the remembered patch no longer heals', async () => {
    sandbox = await Sandbox.create({ files: { [FILE]: BROKEN, '.gitignore': GITIGNORE }, prefix: 'self-heal-memory-' });
    journal = await openJournal(join(sandbox.dir, '.self-heal', 'journal.sqlite'));

    // A patch that was verified once but is now wrong — the file it targets has
    // moved on, which is what happens to any remembered fix eventually.
    await journal.record({
      signature: 'sig-rate',
      kind: 'wrong-value',
      patch: {
        fixerId: 'stale',
        signature: 'sig-rate',
        edits: [{ path: FILE, contents: 'export const rate = 0.1;\n' }],
        rationale: 'stale',
      },
      verified: true,
      attempts: 1,
      replayed: false,
    });

    const fixer = new CountingFixer();
    const report = await runOnce(sandbox.dir, fixer, journal);

    // Replay is a cheaper first guess, never a shortcut past the measurement.
    // The stale patch is applied, measured, rejected, and a real fix follows.
    expect(report.outcomes[0]?.state).toBe('HEALED');
    expect(report.outcomes[0]?.replayed).toBe(false);
    expect(fixer.calls).toBe(1);
    expect(await readFile(join(sandbox.dir, FILE), 'utf8')).toBe(FIXED);
  });

  it('does not offer a patch that was never verified', async () => {
    sandbox = await Sandbox.create({ files: { [FILE]: BROKEN, '.gitignore': GITIGNORE }, prefix: 'self-heal-memory-' });
    const path = join(sandbox.dir, '.self-heal', 'journal.sqlite');
    journal = await openJournal(path);

    await journal.record({
      signature: 'sig-rate',
      kind: 'wrong-value',
      patch: { fixerId: 'failed', signature: 'sig-rate', edits: [{ path: FILE, contents: BROKEN }], rationale: 'no' },
      verified: false,
      attempts: 2,
      replayed: false,
    });

    const fixer = new CountingFixer();
    await runOnce(sandbox.dir, fixer, journal);

    // Only a measured success is worth remembering. Replaying a patch that
    // already failed would burn an attempt against the cap for nothing.
    expect(fixer.calls).toBe(1);
  });

  it('survives its own file being deleted between runs', async () => {
    sandbox = await Sandbox.create({ files: { [FILE]: BROKEN, '.gitignore': GITIGNORE }, prefix: 'self-heal-memory-' });
    const path = join(sandbox.dir, '.self-heal', 'journal.sqlite');
    const fixer = new CountingFixer();

    const first = await openJournal(path);
    await runOnce(sandbox.dir, fixer, first);
    first.close();

    await rm(path, { force: true });
    await writeFile(join(sandbox.dir, FILE), BROKEN, 'utf8');

    // Losing the journal costs money, never correctness: the loop just pays for
    // a fresh proposal, exactly as it did the first time.
    journal = await openJournal(path);
    const second = await runOnce(sandbox.dir, fixer, journal);
    expect(second.outcomes[0]?.state).toBe('HEALED');
    expect(fixer.calls).toBe(2);
  });
});
