import type { Issue } from './issue.js';

/**
 * The compact, bounded description of an issue handed to a fixer.
 *
 * Diagnoses are AST-sliced and capped. Whole files never appear here — growing the
 * context window is the failure mode this project exists to avoid (AGENTS.md).
 */

export interface CodeSlice {
  /** Repository-relative POSIX path. */
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** The sliced source. Bounded by `DIAGNOSIS_SLICE_BUDGET_BYTES`. */
  readonly source: string;
  /** e.g. the enclosing function or class the slice was taken from. */
  readonly symbol?: string;
}

export interface Diagnosis {
  readonly issue: Issue;
  readonly slices: readonly CodeSlice[];
  /** Paths a fixer is permitted to edit for this diagnosis. */
  readonly editableFiles: readonly string[];
}

/** Hard ceiling on the total source bytes a single diagnosis may carry. */
export const DIAGNOSIS_SLICE_BUDGET_BYTES = 16_384;

export function diagnosisSliceBytes(diagnosis: Diagnosis): number {
  return diagnosis.slices.reduce((total, slice) => total + Buffer.byteLength(slice.source, 'utf8'), 0);
}
