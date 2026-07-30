/**
 * Turn "whatever happened in the sandbox" into a `Patch`.
 *
 * This is the load-bearing idea of the whole adapter, and it is worth stating
 * plainly: **we do not ask the model what it changed.** We let it edit a
 * disposable copy of the code, then read the change out of the filesystem with
 * git. The model's own summary of its work is captured for logging and thrown
 * away for decision-making.
 *
 * That choice follows directly from D-001. Asking a model to emit a unified diff
 * makes correctness depend on it counting context lines and hunk offsets — a
 * formatting skill unrelated to whether the fix is right, and one that fails
 * silently. Reading the filesystem removes the question entirely: whatever it
 * did, we see exactly that.
 *
 * It also gives the safety layer something honest to check. Files created or
 * deleted outside the allowlist show up here as facts, before anything is
 * applied to the user's real repository (invariant 4).
 */
import type { GitRepo } from '@self-heal/core/git/repo';
import type { FileEdit, Patch } from '@self-heal/core/contracts/patch';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CaptureResult {
  readonly patch: Patch;
  /** The unified diff, kept for logs, review, and the journal. */
  readonly diff: string;
  /** Paths the harness deleted. Recorded so the safety layer can reject them. */
  readonly deleted: readonly string[];
  /** True when the harness changed nothing at all. */
  readonly empty: boolean;
}

export interface CaptureOptions {
  readonly repo: GitRepo;
  readonly fixerId: string;
  readonly signature: string;
  readonly rationale: string;
}

export async function capturePatch(options: CaptureOptions): Promise<CaptureResult> {
  const { repo } = options;

  // `status --porcelain` sees modified, added, and untracked files alike, so a
  // harness that creates a new file cannot slip past a diff-only check.
  const changes = await repo.changes();
  const diff = await repo.diff();

  const edits: FileEdit[] = [];
  const deleted: string[] = [];

  for (const change of changes) {
    if (change.status === 'deleted') {
      deleted.push(change.path);
      continue;
    }
    // Whole-file contents rather than a diff: applying a patch then becomes a
    // write, which either succeeds or fails — no fuzzy hunk matching against a
    // target file that may have moved on since the sandbox was made.
    const contents = await readFile(join(repo.dir, change.path), 'utf8');
    edits.push({ path: change.path, contents });
  }

  return {
    patch: {
      fixerId: options.fixerId,
      signature: options.signature,
      edits,
      rationale: options.rationale,
    },
    diff,
    deleted,
    empty: edits.length === 0 && deleted.length === 0,
  };
}
