import { createHash } from 'node:crypto';

import type { Issue, IssueLocation } from './contracts/issue.js';

/**
 * The identity of an issue: a stable hash over what the issue *is*, never over when
 * it was seen or what it left on disk.
 *
 * Excluding `detectedAt`, `evidence`, and `severity` is what lets the journal
 * recognise the same regression on a later run (D-006).
 */
export type SignatureInput = Pick<Issue, 'detectorId' | 'kind' | 'expected' | 'actual'> & {
  readonly location: IssueLocation;
};

export function computeSignature(input: SignatureInput): string {
  const canonical = stableStringify({
    detectorId: input.detectorId,
    kind: input.kind,
    location: input.location,
    expected: input.expected,
    actual: input.actual,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** JSON with object keys sorted, so key order can never change an identity. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
