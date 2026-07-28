import type { Patch } from '@self-heal/core/contracts/patch';

import type { OutcomeRow } from './schema.js';

/**
 * Phase 4: the second occurrence of a known regression skips the model entirely.
 *
 * Backed by `node:sqlite` (Node >= 22) so the journal adds no dependency. A lookup
 * that returns a `verified` row is the only thing permitted to trigger `REPLAY`.
 */
export interface Journal {
  lookup(signature: string): Promise<OutcomeRow | undefined>;
  /** `verified` comes from the detector's re-run. There is no other caller. */
  record(signature: string, kind: string, patch: Patch, verified: boolean): Promise<void>;
  close(): Promise<void>;
}

export function openJournal(_path: string): Journal {
  throw new Error('openJournal is not implemented (phase 4)');
}
