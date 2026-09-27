/**
 * A patch is whole-file contents, so it is only safe on the file it was made
 * from (D-020). These run against a real directory — the guarantee is about
 * bytes on disk.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Patch } from '../src/contracts/patch.js';
import { applyPatch } from '../src/safety/apply.js';
import { contentHash, staleEdits, stampBases } from '../src/safety/base.js';
import { Sandbox } from '@self-heal/testkit/sandbox';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  await sandbox?.dispose();
  sandbox = undefined;
});

function patchOf(edits: Patch['edits']): Patch {
  return { fixerId: 't', signature: 's', edits, rationale: 't' };
}

describe('base hashes', () => {
  it('stamps the current file, and null for a file that does not exist yet', async () => {
    sandbox = await Sandbox.create({ files: { 'a.txt': 'one\r\n' }, prefix: 'base-test-' });
    const stamped = await stampBases(
      patchOf([
        { path: 'a.txt', contents: 'two' },
        { path: 'new.txt', contents: 'x' },
      ]),
      sandbox.dir,
    );

    // Raw bytes, CRLF included — a line-ending conversion must not look like a change.
    expect(stamped.edits[0]?.base).toBe(contentHash(Buffer.from('one\r\n')));
    expect(stamped.edits[1]?.base).toBeNull();
  });

  it('reports an edit stale once its file has moved on, and a missing base only when required', async () => {
    sandbox = await Sandbox.create({ files: { 'a.txt': 'now' }, prefix: 'base-test-' });
    const patch = patchOf([
      { path: 'a.txt', contents: 'x', base: contentHash(Buffer.from('then')) },
      { path: 'b.txt', contents: 'x' },
    ]);

    expect(await staleEdits(patch, sandbox.dir, { requireBase: false })).toEqual(['a.txt']);
    expect(await staleEdits(patch, sandbox.dir, { requireBase: true })).toEqual(['a.txt', 'b.txt']);
  });

  it('refuses to write a stale edit, and writes nothing else from that patch', async () => {
    sandbox = await Sandbox.create({ files: { 'a.txt': 'now', 'b.txt': 'b' }, prefix: 'base-test-' });
    const result = await applyPatch(
      patchOf([
        { path: 'b.txt', contents: 'B', base: contentHash(Buffer.from('b')) },
        { path: 'a.txt', contents: 'x', base: contentHash(Buffer.from('then')) },
      ]),
      { repoRoot: sandbox.dir, allowlist: ['*.txt'], checkpoint: 'HEAD' },
    );

    expect(result).toEqual({ applied: false, reason: 'rejected', rejected: [{ path: 'a.txt', reason: 'stale' }] });
    expect(await sandbox.read('b.txt')).toBe('b');
  });
});
