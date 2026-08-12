/**
 * What counts as drift.
 *
 * This file is the opinionated part of the detector, and the opinion is
 * asymmetric on purpose: **removing a field breaks consumers, adding one does
 * not.** A client reading `order.total` breaks the moment `total` disappears or
 * turns into a string. It does not break because the server started sending a new
 * `currency` field alongside it.
 *
 * So additions are silent by default (see D-010). A detector that fires every
 * time someone ships a feature gets switched off within a week, and a detector
 * that is switched off measures nothing — which, for a project whose entire claim
 * is "the deterministic layer measures", is the worst possible failure.
 *
 * `strict: true` is there for the case where the asymmetry does not hold: a
 * response asserted field-for-field against a spec, where an unexpected key is
 * itself the bug.
 */
import type { ShapeMap } from './shape.js';

export type DriftKind =
  | 'field-missing'
  | 'type-changed'
  | 'field-added'
  | 'status-changed'
  | 'body-not-json'
  | 'unreachable';

export interface Drift {
  readonly kind: DriftKind;
  /** JSON path, or `$` for drift about the response as a whole. */
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
}

export interface DiffOptions {
  /** Report fields the recorded contract does not know about. Default false. */
  readonly strict?: boolean;
}

export function diffShapes(recorded: ShapeMap, observed: ShapeMap, options: DiffOptions = {}): Drift[] {
  const drifts: Drift[] = [];

  for (const [path, expected] of Object.entries(recorded)) {
    const actual = observed[path];

    if (actual === undefined) {
      // A field the contract already marked optional was never promised, so its
      // absence is not news.
      if (expected.optional === true) continue;
      drifts.push({
        kind: 'field-missing',
        path,
        expected: describe(expected),
        actual: 'absent',
      });
      continue;
    }

    if (actual.type === expected.type) continue;

    // A nullable field arriving as null is the contract being honoured, not
    // broken. Without this, any endpoint with an optional relation reports drift
    // on roughly half its responses.
    if (actual.type === 'null' && expected.nullable === true) continue;

    drifts.push({
      kind: 'type-changed',
      path,
      expected: describe(expected),
      actual: describe(actual),
    });
  }

  if (options.strict === true) {
    for (const [path, actual] of Object.entries(observed)) {
      if (recorded[path] !== undefined) continue;
      drifts.push({ kind: 'field-added', path, expected: 'absent', actual: describe(actual) });
    }
  }

  // Sorted so that the same drift set always produces the same issue signature,
  // regardless of the order the paths happened to be walked in.
  return drifts.sort((a, b) => (a.path === b.path ? a.kind.localeCompare(b.kind) : a.path < b.path ? -1 : 1));
}

function describe(entry: { type: string; optional?: boolean; nullable?: boolean }): string {
  const flags = [entry.nullable === true ? 'nullable' : null, entry.optional === true ? 'optional' : null].filter(
    (flag): flag is string => flag !== null,
  );
  return flags.length === 0 ? entry.type : `${entry.type} (${flags.join(', ')})`;
}

/** One line per drift, for a prompt or a terminal. Never includes response values. */
export function formatDrifts(drifts: readonly Drift[]): string {
  return drifts.map((drift) => `${drift.kind} at ${drift.path}: expected ${drift.expected}, got ${drift.actual}`).join('\n');
}
