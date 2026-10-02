/**
 * `onInvoke` is how a benchmark (and later a cost report) learns what a proposal
 * cost. Tested against a real process standing in for the harness — the same
 * approach as invoke.test.ts — so the record reflects an actual run.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Diagnosis } from '@self-heal/core/contracts/diagnosis';
import { Sandbox } from '@self-heal/testkit/sandbox';

import { HarnessFixer, buildPrompt, type InvocationRecord } from '../src/index.js';
import { createGitWorkspace } from '../src/workspace.js';
import type { HarnessProfile } from '../src/profiles.js';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  await sandbox?.dispose();
  sandbox = undefined;
});

/** A "harness" that edits a file and reports a cost, like claude-code's JSON envelope. */
const editingHarness: HarnessProfile = {
  id: 'fake',
  command: process.execPath,
  promptDelivery: 'stdin',
  buildArgs: () => [
    '-e',
    "require('fs').writeFileSync('src/value.mjs', 'export const value = 2;\\n'); " +
      "process.stdout.write(JSON.stringify({ result: 'set value to 2', cost: 0.0123, turns: 3 }))",
  ],
  parseResult: (stdout) => {
    const parsed = JSON.parse(stdout) as { result: string; cost: number; turns: number };
    return { text: parsed.result, costUsd: parsed.cost, turns: parsed.turns, reportedError: false };
  },
};

const diagnosis: Diagnosis = {
  issue: {
    signature: 'sig-1',
    detectorId: 'd',
    kind: 'wrong-value',
    location: { file: 'src/value.mjs', line: 1 },
    expected: 2,
    actual: 1,
    evidence: [],
    severity: 'high',
    detectedAt: '2026-01-01T00:00:00.000Z',
  },
  slices: [],
  editableFiles: ['src/value.mjs'],
};

describe('HarnessFixer', () => {
  it('reports what each harness run cost, and still returns the patch from git', async () => {
    sandbox = await Sandbox.create({ files: { 'src/value.mjs': 'export const value = 1;\n' }, prefix: 'fixer-test-' });
    const repoRoot = sandbox.dir;
    const records: InvocationRecord[] = [];
    const fixer = new HarnessFixer({
      harness: editingHarness,
      createWorkspace: () => createGitWorkspace({ repoRoot }),
      onInvoke: (record) => records.push(record),
    });

    const patch = await fixer.propose(diagnosis);

    expect(patch.edits).toEqual([{ path: 'src/value.mjs', contents: 'export const value = 2;\n' }]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ signature: 'sig-1', ok: true, failure: null, costUsd: 0.0123, turns: 3 });
    expect(records[0]?.promptBytes).toBe(Buffer.byteLength(buildPrompt(diagnosis), 'utf8'));
  });

  it('reports a failed run too — a failed call still cost something', async () => {
    sandbox = await Sandbox.create({ files: { 'src/value.mjs': 'x\n' }, prefix: 'fixer-test-' });
    const repoRoot = sandbox.dir;
    const records: InvocationRecord[] = [];
    const fixer = new HarnessFixer({
      harness: { ...editingHarness, buildArgs: () => ['-e', 'process.exit(3)'], parseResult: () => null },
      createWorkspace: () => createGitWorkspace({ repoRoot }),
      onInvoke: (record) => records.push(record),
    });

    const patch = await fixer.propose(diagnosis);

    expect(patch.edits).toEqual([]);
    expect(records[0]).toMatchObject({ ok: false, failure: 'unparseable', costUsd: null });
  });
});
