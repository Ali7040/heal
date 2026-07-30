/**
 * Capture is the step that decides what the model "did", so it is tested
 * without a model: the sandbox stands in for the harness by making the same
 * kinds of edits a harness would. If capture is right, a real run is just this
 * with a slower editor.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { GitRepo } from '@self-heal/core/git/repo';
import { Sandbox } from '@self-heal/testkit/sandbox';

import { capturePatch } from '../src/capture.js';

const FILES = {
  'src/a.mjs': 'export const a = 1;\n',
  'src/b.mjs': 'export const b = 2;\n',
};

let sandbox: Sandbox | undefined;

afterEach(async () => {
  await sandbox?.dispose();
  sandbox = undefined;
});

async function captureFrom(box: Sandbox) {
  return capturePatch({
    repo: new GitRepo({ dir: box.dir }),
    fixerId: 'test',
    signature: 'sig-1',
    rationale: 'test capture',
  });
}

describe('capturePatch', () => {
  it('reports no change as empty rather than as failure', async () => {
    sandbox = await Sandbox.create({ files: FILES, prefix: 'capture-test-' });

    const result = await captureFrom(sandbox);

    expect(result.empty).toBe(true);
    expect(result.patch.edits).toEqual([]);
  });

  it('captures modified file contents, not the diff text', async () => {
    sandbox = await Sandbox.create({ files: FILES, prefix: 'capture-test-' });
    await sandbox.write('src/a.mjs', 'export const a = 42;\n');

    const result = await captureFrom(sandbox);

    expect(result.empty).toBe(false);
    expect(result.patch.edits).toEqual([{ path: 'src/a.mjs', contents: 'export const a = 42;\n' }]);
    // The unified diff is kept alongside for logs, but it is not the patch.
    expect(result.diff).toContain('export const a = 42;');
  });

  it('sees files the harness created, which a diff-only check would miss', async () => {
    sandbox = await Sandbox.create({ files: FILES, prefix: 'capture-test-' });
    await sandbox.write('src/sneaky.mjs', 'export const c = 3;\n');

    const result = await captureFrom(sandbox);

    // Untracked files must surface here so the allowlist can reject them
    // before anything reaches the user's repository (invariant 4).
    expect(result.patch.edits.map((e) => e.path)).toContain('src/sneaky.mjs');
  });

  it('records deletions separately from edits', async () => {
    sandbox = await Sandbox.create({ files: FILES, prefix: 'capture-test-' });
    await sandbox.git.git('rm', '-q', 'src/b.mjs');

    const result = await captureFrom(sandbox);

    expect(result.deleted).toEqual(['src/b.mjs']);
    expect(result.patch.edits.map((e) => e.path)).not.toContain('src/b.mjs');
  });

  it('carries the issue signature through, so a patch can never be attributed to the wrong issue', async () => {
    sandbox = await Sandbox.create({ files: FILES, prefix: 'capture-test-' });
    await sandbox.write('src/a.mjs', 'export const a = 9;\n');

    const result = await captureFrom(sandbox);

    expect(result.patch.signature).toBe('sig-1');
    expect(result.patch.fixerId).toBe('test');
  });
});
