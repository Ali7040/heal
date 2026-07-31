/**
 * A detector whose entire measurement is an exit code.
 *
 * Point it at `npm test`, a type checker, a linter, or any script: exit 0 means
 * healthy, anything else is an issue. That is not a toy — it is how most real
 * regressions are actually observed, and it makes the loop useful on day one
 * without waiting for the schema and visual detectors.
 *
 * It also earns its place architecturally. Because `verify()` re-runs the exact
 * same command, this detector cannot possibly disagree with itself about what
 * "fixed" means (D-002). Any detector that needs a subtler measurement now has a
 * working example of the contract to imitate.
 *
 * The interesting design problem here is the signature. It must be stable across
 * runs of the *same* failure, and different for a *different* failure — while the
 * output it is derived from is full of noise: timings, absolute paths, PIDs. See
 * `fingerprint` below.
 */
import type { RunContext } from '@self-heal/core/contracts/context';
import type { Detector } from '@self-heal/core/contracts/detector';
import type { Issue } from '@self-heal/core/contracts/issue';
import { runCommand } from '@self-heal/core/process';
import { computeSignature } from '@self-heal/core/signature';

export interface CommandDetectorOptions {
  /** Stable id — it ends up in every issue this detector produces. */
  readonly id?: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  /** Files a fixer may edit when this check fails. */
  readonly editable?: readonly string[];
  /** Reported on issues; drives triage ordering later. */
  readonly severity?: Issue['severity'];
  /** Issue kind, so several command detectors can be told apart in the journal. */
  readonly kind?: string;
}

export class CommandDetector implements Detector {
  readonly id: string;
  readonly #options: CommandDetectorOptions;

  constructor(options: CommandDetectorOptions) {
    this.id = options.id ?? 'command';
    this.#options = options;
  }

  async detect(ctx: RunContext): Promise<Issue[]> {
    const result = await this.#measure(ctx);
    if (result.healthy) return [];

    const kind = this.#options.kind ?? 'check-failed';
    // `exactOptionalPropertyTypes` forces the distinction between "absent" and
    // "present but undefined" — and it matters here, because the signature is a
    // hash of this object. An explicit `file: undefined` would serialize
    // differently from an omitted key and split one issue into two identities.
    const firstEditable = this.#options.editable?.[0];
    const location: Issue['location'] = firstEditable === undefined ? {} : { file: firstEditable };
    const expected = { exitCode: 0 };
    const actual = { exitCode: result.exitCode, failure: fingerprint(result.output) };

    return [
      {
        signature: computeSignature({ detectorId: this.id, kind, location, expected, actual }),
        detectorId: this.id,
        kind,
        location,
        expected,
        actual,
        // The raw output is evidence and lives on disk. Only the fingerprint —
        // small, stable, hashable — travels inside the issue.
        evidence: [],
        severity: this.#options.severity ?? 'high',
        detectedAt: new Date().toISOString(),
      },
    ];
  }

  /**
   * The same measurement, re-run. Note what is absent: any reference to the
   * patch, the fixer, or what was attempted. This method cannot tell the
   * difference between "a model fixed it" and "someone fixed it by hand", which
   * is precisely the property that makes `HEALED` mean something.
   */
  async verify(_issue: Issue, ctx: RunContext): Promise<boolean> {
    const result = await this.#measure(ctx);
    return result.healthy;
  }

  async #measure(ctx: RunContext): Promise<{ healthy: boolean; exitCode: number | null; output: string }> {
    const result = await runCommand(this.#options.command, this.#options.args ?? [], {
      cwd: ctx.repoRoot,
      timeoutMs: this.#options.timeoutMs ?? 60_000,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    return {
      // A timeout is not health. Only a clean exit 0 counts.
      healthy: result.ok,
      exitCode: result.code,
      output: `${result.stdout}${result.stderr}`.trim(),
    };
  }
}

/**
 * Reduce noisy output to something stable enough to hash.
 *
 * Without this, the same failing test produces a new signature on every run —
 * the journal never gets a hit, every occurrence pays for a model call, and the
 * attempt cap never engages because each attempt looks like a brand-new issue.
 * Normalizing timings, paths, hex ids, and line/column numbers is what makes
 * "the same bug" a decidable question.
 */
export function fingerprint(output: string): string {
  return output
    .split('\n')
    .filter((line) => /fail|error|expected|assert/i.test(line))
    .slice(0, 20)
    .map((line) =>
      line
        .trim()
        .replace(/\d+(\.\d+)?\s*(ms|s|seconds?)\b/gi, '<time>')
        .replace(/[A-Za-z]:\\[^\s:]+|\/(?:[\w.-]+\/)+[\w.-]+/g, '<path>')
        .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
        .replace(/:\d+:\d+/g, ':<pos>'),
    )
    .join('\n');
}
