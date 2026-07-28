import type { RunContext } from '@self-heal/core/contracts/context';
import type { Detector } from '@self-heal/core/contracts/detector';
import type { Issue } from '@self-heal/core/contracts/issue';

/**
 * Phase 5: a frontend regression flows through the same engine, unmodified.
 *
 * Screenshots and diff blobs are written under `ctx.evidenceDir` and referenced by
 * path — a pixel buffer must never reach an `Issue`, a log line, or a prompt.
 */
export class VisualDetector implements Detector {
  readonly id = 'visual';

  async detect(_ctx: RunContext): Promise<Issue[]> {
    throw new Error('VisualDetector.detect is not implemented (phase 5)');
  }

  async verify(_issue: Issue, _ctx: RunContext): Promise<boolean> {
    throw new Error('VisualDetector.verify is not implemented (phase 5)');
  }
}
