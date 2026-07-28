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
