import type { RunContext } from '@self-heal/core/contracts/context';
import type { Detector } from '@self-heal/core/contracts/detector';
import type { Issue } from '@self-heal/core/contracts/issue';

/**
 * Phase 2: a deliberately broken endpoint is detected.
 *
 * `detect` diffs a live response against the recorded schema; `verify` re-runs
 * exactly that comparison for one issue (D-002). Both are ordinary code with
 * ordinary exit codes — no model is reachable from this file, by design.
 */
export class ContractDetector implements Detector {
  readonly id = 'contract';

  async detect(_ctx: RunContext): Promise<Issue[]> {
    throw new Error('ContractDetector.detect is not implemented (phase 2)');
  }

  async verify(_issue: Issue, _ctx: RunContext): Promise<boolean> {
    throw new Error('ContractDetector.verify is not implemented (phase 2)');
  }
}
