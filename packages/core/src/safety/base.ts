/**
 * What a patch was made against.
 *
 * A patch is whole-file contents (see `capture.ts` for why). That makes applying
 * it a plain write, which is its strength — and its danger: written onto a file
 * that has changed since the patch was made, it silently reverts every change in
 * between. The originating detector cannot catch that; it measures one thing, and
 * the reverted work is usually something else (D-020).
 *
 * So every edit carries the hash of the file it was derived from, and a write is
 * refused when the file on disk no longer matches. Hashes are over raw bytes, read
 * from the real tree — never from `git show`, whose line-ending conversion would
 * make a CRLF checkout look stale forever.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Patch } from '../contracts/patch.js';

export function contentHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The hash of a file in the tree now, or `null` if it does not exist. */
export async function currentHash(repoRoot: string, path: string): Promise<string | null> {
  try {
    return contentHash(await readFile(join(repoRoot, path)));
  } catch {
    return null;
  }
}

/**
 * Record, for each edit, the file it applies to as the tree has it now.
 *
 * Called by the runner straight after a fresh proposal, when the tree is by
 * construction the one the fixer's sandbox was copied from.
 */
export async function stampBases(patch: Patch, repoRoot: string): Promise<Patch> {
  const edits = await Promise.all(
    patch.edits.map(async (edit) => ({ ...edit, base: await currentHash(repoRoot, edit.path) })),
  );
  return { ...patch, edits };
}

/**
 * Paths whose file no longer matches the edit's base.
 *
 * With `requireBase`, an edit that never recorded one counts as stale too — the
 * right answer for a replayed patch, whose base is the only evidence it still fits.
 */
export async function staleEdits(
  patch: Patch,
  repoRoot: string,
  options: { readonly requireBase: boolean },
): Promise<string[]> {
  const stale: string[] = [];
  for (const edit of patch.edits) {
    if (edit.base === undefined) {
      if (options.requireBase) stale.push(edit.path);
      continue;
    }
    if ((await currentHash(repoRoot, edit.path)) !== edit.base) stale.push(edit.path);
  }
  return stale;
}
