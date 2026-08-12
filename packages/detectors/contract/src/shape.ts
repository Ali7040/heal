/**
 * Turning a JSON response into something that can be compared.
 *
 * The problem this solves: an API response is mostly *values*, and values change
 * on every request — ids, timestamps, prices, counts. Comparing two responses
 * directly would report drift constantly and mean nothing. What a consumer of an
 * API actually depends on is the *shape*: which fields exist, and what type each
 * one holds. So that is what gets recorded and compared, and values are discarded
 * before anything is stored.
 *
 * The representation is a flat map of path → type rather than a nested tree:
 *
 *   $                  object
 *   $.orders           array
 *   $.orders[].id      number
 *   $.orders[].total   number
 *
 * Flat because every operation downstream is easier on it. Diffing is a key-set
 * comparison instead of a recursive walk; a drift names the exact path a fixer
 * has to care about; and the whole thing serializes to stable JSON, which matters
 * because it gets committed to a repository and read by humans in code review.
 */

export type TypeName = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

export interface ShapeEntry {
  /** `mixed` means the same path held different types across array elements. */
  readonly type: TypeName | 'mixed';
  /** Absent from at least one sibling — an array of partially-filled records. */
  readonly optional?: boolean;
  /** Observed as `null` at least once, alongside a real type. */
  readonly nullable?: boolean;
}

/** Path → what was found there. Keys are sorted, so the JSON is stable. */
export type ShapeMap = Readonly<Record<string, ShapeEntry>>;

export const ROOT = '$';

interface Observation {
  readonly types: Set<TypeName>;
  count: number;
}

export function describeShape(value: unknown): ShapeMap {
  const seen = new Map<string, Observation>();
  walk(ROOT, value, seen);

  const out: Record<string, ShapeEntry> = {};
  for (const path of [...seen.keys()].sort()) {
    const observation = seen.get(path);
    /* c8 ignore next */
    if (observation === undefined) continue;
    out[path] = summarize(path, observation, seen);
  }
  return out;
}

function walk(path: string, value: unknown, seen: Map<string, Observation>): void {
  const type = typeOf(value);
  record(path, type, seen);

  if (type === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(`${path}.${key}`, child, seen);
    }
    return;
  }

  if (type === 'array') {
    // Every element folds onto the SAME path. Ten orders produce one
    // `$.orders[].id` entry observed ten times, not ten paths — which is what
    // makes the recorded contract independent of how many rows the API returned
    // on the day it was recorded.
    for (const element of value as unknown[]) walk(`${path}[]`, element, seen);
  }
}

function record(path: string, type: TypeName, seen: Map<string, Observation>): void {
  const existing = seen.get(path);
  if (existing === undefined) {
    seen.set(path, { types: new Set([type]), count: 1 });
    return;
  }
  existing.types.add(type);
  existing.count += 1;
}

/**
 * Optionality is derived, not declared: a path is optional when it appeared
 * fewer times than its parent did.
 *
 * `$.orders[].note` seen 3 times under an `$.orders[]` seen 10 times means seven
 * orders had no note — so a later response without one is not drift. Getting
 * this wrong in either direction is what makes schema tooling annoying enough to
 * turn off: too strict and every optional field is a false alarm, too loose and a
 * dropped field goes unnoticed.
 */
function summarize(path: string, observation: Observation, seen: Map<string, Observation>): ShapeEntry {
  const parent = parentOf(path);
  const parentCount = parent === null ? 1 : (seen.get(parent)?.count ?? 1);
  const optional = observation.count < parentCount;

  const types = [...observation.types];
  const concrete = types.filter((type) => type !== 'null');
  // `nullable` means "a real type, sometimes null". A field only ever seen as
  // null is just `null` — tagging it nullable as well is redundant, and it leaks
  // into drift messages as the nonsense "expected null (nullable)".
  const nullable = concrete.length > 0 && types.length > concrete.length;

  const type: ShapeEntry['type'] =
    concrete.length === 0 ? 'null' : concrete.length === 1 ? (concrete[0] as TypeName) : 'mixed';

  return {
    type,
    // `exactOptionalPropertyTypes` again: an explicit `optional: false` would
    // serialize into the recorded contract file and change its bytes for no
    // reason. Absent means absent.
    ...(optional ? { optional: true } : {}),
    ...(nullable ? { nullable: true } : {}),
  };
}

/** `$.a.b` → `$.a`, `$.a[]` → `$.a`, `$` → null. */
export function parentOf(path: string): string | null {
  if (path === ROOT) return null;
  if (path.endsWith('[]')) return path.slice(0, -2);
  const dot = path.lastIndexOf('.');
  return dot <= 0 ? ROOT : path.slice(0, dot);
}

function typeOf(value: unknown): TypeName {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'object';
  }
}
