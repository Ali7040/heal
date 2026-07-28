import type { RunContext } from './context.js';
import type { Issue } from './issue.js';

/**
 * A source of measurements.
 *
 * `verify` lives here on purpose (D-002): the detector that found a problem is the
 * only thing qualified to say it is gone. `HEALED` therefore has exactly one meaning —
 * the original measurement now passes.
 */
export interface Detector {
  readonly id: string;

  detect(ctx: RunContext): Promise<Issue[]>;

  /**
   * Re-run the measurement that produced `issue`.
   *
   * Returns the measured result and nothing else. A detector must never consult a
   * model here, and must never return `true` on the basis of a patch having been
   * applied — only on the basis of the measurement passing.
   */
  verify(issue: Issue, ctx: RunContext): Promise<boolean>;
}
