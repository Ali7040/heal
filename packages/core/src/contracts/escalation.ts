/**
 * What the loop knew when it gave up.
 *
 * `ESCALATED` is the one moment a person takes over, and before this existed
 * they inherited a one-line reason: everything the loop learned — the code it
 * showed the model, each attempt, why each one was measured a failure — was
 * thrown away. This is that knowledge as data (D-028). How it is presented (a
 * Markdown file, a PR comment) is the consumer's business, not `core`'s.
 */
import type { Diagnosis } from './diagnosis.js';
import type { Issue } from './issue.js';

export interface AttemptRecord {
  /** 1-based, in the order tried. A journal replay, if any, is first. */
  readonly number: number;
  readonly replayed: boolean;
  readonly files: readonly string[];
  /** The fixer's one-line account of what it tried. Context, not evidence. */
  readonly rationale: string;
  /** Why it failed, as measured by the runner. */
  readonly reason: string;
  /**
   * What the attempt changed, as `git diff` saw it before the tree was restored.
   * Absent when the patch was never applied (rejected, empty). Capped at
   * `ESCALATION_DIFF_LIMIT` characters.
   */
  readonly diff?: string;
}

export interface EscalationReport {
  readonly issue: Issue;
  /** The runner's one-line reason for giving up. */
  readonly reason: string;
  /** The last diagnosis built — what the model was last shown. */
  readonly diagnosis?: Diagnosis;
  readonly attempts: readonly AttemptRecord[];
  /** ISO-8601. */
  readonly escalatedAt: string;
}

export const ESCALATION_DIFF_LIMIT = 20_000;
