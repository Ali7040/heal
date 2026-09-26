import type { Issue } from './issue.js';

/**
 * The compact, bounded description of an issue handed to a fixer.
 *
 * Diagnoses are sliced by declaration (or outlined) and capped — see D-019. Whole files never appear here — growing the
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

/**
 * A patch that was already measured and failed for this issue, in this run.
 *
 * Deliberately a summary, not the patch: paths, the fixer's one-line rationale,
 * and the runner's measured reason. File contents never ride along, so a retry
 * costs a few hundred bytes more than the first attempt, not a second copy of it.
 */
export interface PriorAttempt {
  readonly files: readonly string[];
  readonly rationale: string;
  /** Why it failed — written by the runner from a measurement, never by a fixer. */
  readonly reason: string;
}

export interface Diagnosis {
  readonly issue: Issue;
  readonly slices: readonly CodeSlice[];
  /** Paths a fixer is permitted to edit for this diagnosis. */
  readonly editableFiles: readonly string[];
  /** Earlier failed attempts at this issue, oldest first. Absent on a first try. */
  readonly priorAttempts?: readonly PriorAttempt[];
}

/** Cap on each free-text field of a `PriorAttempt`, in characters. */
export const PRIOR_ATTEMPT_TEXT_LIMIT = 300;

/** Hard ceiling on the total source bytes a single diagnosis may carry. */
export const DIAGNOSIS_SLICE_BUDGET_BYTES = 16_384;

export function diagnosisSliceBytes(diagnosis: Diagnosis): number {
  return diagnosis.slices.reduce((total, slice) => total + Buffer.byteLength(slice.source, 'utf8'), 0);
}
