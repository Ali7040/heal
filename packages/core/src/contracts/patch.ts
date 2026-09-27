/**
 * An untrusted proposal from a fixer.
 *
 * Nothing here is believed. A patch is allowlist-checked before it is applied, and
 * measured after (see safety/allowlist and D-001).
 */

export interface FileEdit {
  /** Repository-relative POSIX path. Absolute paths are rejected by the allowlist. */
  readonly path: string;
  /** Full contents to write. Whole-file replacement keeps application deterministic. */
  readonly contents: string;
  /**
   * Hash of the file this edit was made against (`null`: it did not exist).
   *
   * Whole-file contents are only safe to write onto the file they were derived
   * from — written onto a newer one, they silently revert every change since. The
   * runner stamps this from the real tree, and a mismatch refuses the write (D-020).
   * Absent means unknown: accepted for a fresh proposal, refused for a replay.
   */
  readonly base?: string | null;
}

export interface Patch {
  readonly fixerId: string;
  /** Signature of the issue this patch claims to address. */
  readonly signature: string;
  readonly edits: readonly FileEdit[];
  /** One line, for the checkpoint commit message and the journal. */
  readonly rationale: string;
}

/** A patch with no edits — the fixer declined to propose. Never an error. */
export function isEmptyPatch(patch: Patch): boolean {
  return patch.edits.length === 0;
}
