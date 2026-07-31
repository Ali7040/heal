/**
 * Writing a patch to disk — the only place this system mutates a real repository.
 *
 * Two rules make it safe, and both are about *ordering*:
 *
 *   1. The allowlist is checked for the whole patch before a single byte is
 *      written (invariant 4). Validating file-by-file while writing would leave
 *      a half-applied patch behind when the third edit is rejected.
 *   2. A caller must have taken a checkpoint first (invariant 1). This function
 *      demands the checkpoint SHA as an argument rather than trusting the caller
 *      to remember — you cannot call it without having one.
 *
 * Rejection is a returned value, never a throw. "The fixer proposed something
 * illegal" is an ordinary outcome the state machine handles as `REVERTED`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Patch } from '../contracts/patch.js';
import { checkPatch, type AllowlistRejection } from './allowlist.js';

export interface ApplyOptions {
  readonly repoRoot: string;
  readonly allowlist: readonly string[];
  /**
   * Proof that a checkpoint exists. Not used for the write itself — it is here so
   * the type system refuses an unprotected mutation (invariant 1).
   */
  readonly checkpoint: string;
}

export type ApplyResult =
  | { readonly applied: true; readonly files: readonly string[] }
  | { readonly applied: false; readonly reason: 'rejected'; readonly rejected: readonly AllowlistRejection[] }
  | { readonly applied: false; readonly reason: 'empty' }
  | { readonly applied: false; readonly reason: 'write-failed'; readonly error: string };

export async function applyPatch(patch: Patch, options: ApplyOptions): Promise<ApplyResult> {
  if (patch.edits.length === 0) {
    return { applied: false, reason: 'empty' };
  }

  // Gate first, write second. Never interleaved.
  const check = checkPatch(patch, options.allowlist);
  if (!check.ok) {
    return { applied: false, reason: 'rejected', rejected: check.rejected };
  }

  const written: string[] = [];
  try {
    for (const edit of patch.edits) {
      const target = join(options.repoRoot, edit.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, edit.contents, 'utf8');
      written.push(edit.path);
    }
  } catch (error) {
    // A partial write is not cleaned up here on purpose: the runner owns rollback,
    // and it restores from the checkpoint, which undoes strictly more than we could.
    return { applied: false, reason: 'write-failed', error: error instanceof Error ? error.message : String(error) };
  }

  return { applied: true, files: written };
}
