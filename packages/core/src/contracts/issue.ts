/**
 * A measured fact about the system.
 *
 * An `Issue` is only ever produced by deterministic code. If a value in here came
 * from a model, the contract has been violated (see D-001).
 */

/** Kinds are open for extension by detectors, closed for the ones core knows about. */
export type IssueKind = 'schema-mismatch' | 'visual-regression' | (string & {});

export type Severity = 'low' | 'medium' | 'high';

export interface IssueLocation {
  readonly file?: string;
  readonly line?: number;
  /** Backend detectors. */
  readonly endpoint?: string;
  /** Frontend detectors. */
  readonly selector?: string;
}

/**
 * A pointer to an artifact on disk. Never the artifact itself.
 *
 * Screenshots and diff blobs stay on disk so an `Issue` stays small enough to hash,
 * log, and store cheaply — and so a stray blob can never be serialized into a prompt.
 */
export interface EvidenceRef {
  readonly kind: 'screenshot' | 'diff' | 'response-body' | 'log' | (string & {});
  /** Path relative to the run's evidence directory. */
  readonly path: string;
  readonly mediaType?: string;
}

export interface Issue {
  /** Deterministic hash — the cache key and the identity of this issue. */
  readonly signature: string;
  /** Who found it — and therefore who must verify the fix (D-002). */
  readonly detectorId: string;
  readonly kind: IssueKind;
  readonly location: IssueLocation;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly evidence: readonly EvidenceRef[];
  /**
   * Places the measurement's own output pointed at — `src/a.ts:12` in a stack
   * trace or a compiler error — most relevant first. Where to *look*, not what the
   * issue *is*: excluded from the signature, so a line shifting between runs does
   * not split one bug into two identities (D-024).
   */
  readonly related?: readonly IssueLocation[];
  readonly severity: Severity;
  /** ISO-8601. */
  readonly detectedAt: string;
}
