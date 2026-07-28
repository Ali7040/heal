/**
 * Not a cache of answers — a record of measured outcomes.
 *
 * `verified` is written from the originating detector's re-run, never from a model's
 * claim of success. That distinction is the whole value of this table.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS outcomes (
  signature    TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  patch        TEXT NOT NULL,
  verified     INTEGER NOT NULL,  -- 0/1 — measured, never self-reported
  attempts     INTEGER NOT NULL,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL
);
`;

export interface OutcomeRow {
  readonly signature: string;
  readonly kind: string;
  /** Serialized patch. */
  readonly patch: string;
  readonly verified: 0 | 1;
  readonly attempts: number;
  readonly first_seen: string;
  readonly last_seen: string;
}
