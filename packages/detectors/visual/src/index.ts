/**
 * Phase 5: a visual regression flows through the same engine, unmodified.
 *
 * The shape of this detector is deliberately the same as the contract detector's,
 * because the shape turned out to be the reusable part: boot the system, take a
 * measurement, compare it against a baseline recorded in the repository, write the
 * evidence to disk, and re-measure with a fresh boot when verifying. Only the
 * *measurement* differs — pixels instead of JSON keys.
 *
 * That similarity is the phase's actual result. Two detectors with nothing in
 * common at the domain level ended up needing exactly one shared primitive
 * (`withServer`, now in `core`), and the runner still cannot tell any of them
 * apart.
 *
 * Pixel buffers never reach an `Issue`. Screenshots, baselines, and diff images
 * are written under `ctx.evidenceDir` and referenced by path (ARCHITECTURE §2).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { RunContext } from '@self-heal/core/contracts/context';
import type { Detector } from '@self-heal/core/contracts/detector';
import type { EvidenceRef, Issue, Severity } from '@self-heal/core/contracts/issue';
import { withServer, type ServerConfig } from '@self-heal/core/server';
import { computeSignature } from '@self-heal/core/signature';

import { compareImages, renderDiffImage, type Comparison } from './compare.js';
import { decodePng, encodePng, isPng, PngError, type RgbaImage } from './png.js';
import { CaptureError, UrlScreenshotter, type Screenshotter } from './capture.js';

export { decodePng, encodePng, isPng, PngError, type RgbaImage } from './png.js';
export { compareImages, renderDiffImage, DEFAULT_TOLERANCE, DEFAULT_MAX_RATIO, type Comparison } from './compare.js';
export {
  CaptureError,
  PlaywrightScreenshotter,
  StaticScreenshotter,
  UrlScreenshotter,
  type Capture,
  type Screenshotter,
} from './capture.js';

export const DEFAULT_BASELINE_DIR = '.self-heal/baselines';

export interface ViewConfig {
  /** Stable name — the baseline filename and the issue's identity. */
  readonly name: string;
  /** Where the image comes from. A URL is shorthand for `UrlScreenshotter`. */
  readonly url?: string;
  readonly screenshotter?: Screenshotter;
  /** CSS-ish selector, recorded on the issue for a fixer's benefit. */
  readonly selector?: string;
  /** Files a fixer may edit when this view regresses. */
  readonly editable?: readonly string[];
}

export interface VisualDetectorOptions {
  readonly id?: string;
  readonly views: readonly ViewConfig[];
  /** Boots before every measurement and dies after it, as in phase 2 (D-011). */
  readonly server?: ServerConfig;
  readonly baselineDir?: string;
  readonly tolerance?: number;
  readonly maxRatio?: number;
  /** `never` refuses to record a missing baseline — for CI. */
  readonly record?: 'missing' | 'never';
  readonly severity?: Severity;
}

export class MissingBaselineError extends Error {}

export class VisualDetector implements Detector {
  readonly id: string;
  readonly #options: VisualDetectorOptions;

  constructor(options: VisualDetectorOptions) {
    this.id = options.id ?? 'visual';
    this.#options = options;
  }

  async detect(ctx: RunContext): Promise<Issue[]> {
    return this.#withServer(ctx, async () => {
      const issues: Issue[] = [];
      for (const view of this.#options.views) {
        const issue = await this.#detectOne(view, ctx);
        if (issue !== null) issues.push(issue);
      }
      return issues;
    });
  }

  /**
   * Re-measure the one view this issue came from, against the same baseline.
   *
   * A fresh boot, for the reason phase 2 found the hard way: a process started
   * before the fix still renders the old code, so re-capturing from it would
   * verify the previous build (D-011).
   */
  async verify(issue: Issue, ctx: RunContext): Promise<boolean> {
    const view = this.#options.views.find((candidate) => candidate.name === issue.location.selector);
    if (view === undefined) return false;

    return this.#withServer(ctx, async () => {
      const baseline = await this.#readBaseline(ctx, view.name);
      // Deleting a baseline must not be a way to make an issue disappear.
      if (baseline === null) return false;

      try {
        const actual = await this.#capture(view);
        return compareImages(baseline, actual, this.#compareOptions()).matched;
      } catch {
        // A capture that fails is not a passing measurement. Most often it means
        // the fixer just broke the page it was editing.
        return false;
      }
    });
  }

  async #detectOne(view: ViewConfig, ctx: RunContext): Promise<Issue | null> {
    const baseline = await this.#readBaseline(ctx, view.name);

    let actual: RgbaImage;
    try {
      actual = await this.#capture(view);
    } catch (error) {
      if (baseline === null) throw error;
      // A view that cannot be captured is a regression in its own right, and one
      // a fixer can often act on — a page that now throws renders nothing.
      return this.#issue(view, ctx, null, {
        matched: false,
        diffPixels: 0,
        totalPixels: 0,
        ratio: 1,
        region: null,
        sizeChanged: false,
      }, (error as Error).message);
    }

    if (baseline === null) {
      if ((this.#options.record ?? 'missing') === 'never') {
        throw new MissingBaselineError(
          `no baseline for view "${view.name}" in ${this.#baselineDir(ctx)}.\n` +
            'Run once with record="missing" and commit the PNG, or fix the view name.',
        );
      }
      // Nothing to compare against yet, so there is nothing to report. The next
      // run is the first one that can have an opinion.
      await this.#writeBaseline(ctx, view.name, actual);
      ctx.log.info(`visual: recorded baseline for "${view.name}"`, { view: view.name });
      return null;
    }

    const comparison = compareImages(baseline, actual, this.#compareOptions());
    if (comparison.matched) return null;

    return this.#issue(view, ctx, { baseline, actual }, comparison, null);
  }

  async #issue(
    view: ViewConfig,
    ctx: RunContext,
    images: { baseline: RgbaImage; actual: RgbaImage } | null,
    comparison: Comparison,
    captureError: string | null,
  ): Promise<Issue> {
    const location: Issue['location'] = {
      // `selector` carries the view name: it is the frontend half of `location`,
      // and it is what `verify` looks the view up by.
      selector: view.name,
      ...(view.editable?.[0] !== undefined ? { file: view.editable[0] } : {}),
    };
    const kind = 'visual-regression';

    // Only summary numbers enter the signature — never pixels, and never a byte
    // count that would shift with PNG compression. `ratio` is rounded so that the
    // same regression keeps one identity across runs, which is what the journal,
    // the attempt cap, and the circuit breaker all key off.
    const expected = { view: view.name, match: 'within tolerance' };
    const actual = captureError !== null
      ? { view: view.name, capture: 'failed', reason: captureError }
      : {
          view: view.name,
          diffRatio: comparison.ratio,
          sizeChanged: comparison.sizeChanged,
          region: comparison.region,
        };

    return {
      signature: computeSignature({ detectorId: this.id, kind, location, expected, actual }),
      detectorId: this.id,
      kind,
      location,
      expected,
      actual,
      evidence: images === null ? [] : await this.#writeEvidence(view, ctx, images),
      severity: this.#options.severity ?? 'high',
      detectedAt: new Date().toISOString(),
    };
  }

  /**
   * Three artifacts: what was expected, what arrived, and what differs.
   *
   * The diff image is the one a person actually looks at, and it is the reason
   * this evidence is worth writing at all — "0.8% of pixels differ" says a
   * regression happened and nothing about what.
   */
  async #writeEvidence(
    view: ViewConfig,
    ctx: RunContext,
    images: { baseline: RgbaImage; actual: RgbaImage },
  ): Promise<EvidenceRef[]> {
    const tolerance = this.#options.tolerance;
    const files: [string, RgbaImage][] = [
      [`visual/${slug(view.name)}.expected.png`, images.baseline],
      [`visual/${slug(view.name)}.actual.png`, images.actual],
      [
        `visual/${slug(view.name)}.diff.png`,
        tolerance === undefined
          ? renderDiffImage(images.baseline, images.actual)
          : renderDiffImage(images.baseline, images.actual, tolerance),
      ],
    ];

    const refs: EvidenceRef[] = [];
    for (const [relative, image] of files) {
      const target = join(ctx.evidenceDir, relative);
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, encodePng(image));
        refs.push({ kind: 'screenshot', path: relative, mediaType: 'image/png' });
      } catch (error) {
        // Evidence is diagnostic, not load-bearing. A read-only evidence
        // directory must not stop a real regression from being reported.
        ctx.log.warn('visual: could not write evidence', { path: target, error: String(error) });
      }
    }
    return refs;
  }

  async #capture(view: ViewConfig): Promise<RgbaImage> {
    const screenshotter = this.#screenshotterFor(view);
    const { bytes, source } = await screenshotter.capture();

    if (!isPng(bytes)) {
      // Nearly always an error page returned with the wrong content type. Saying
      // so beats a decode error about a bad signature.
      throw new CaptureError(`${source} did not return a PNG (${bytes.length} bytes)`);
    }
    try {
      return decodePng(bytes);
    } catch (error) {
      throw error instanceof PngError ? new CaptureError(`${source}: ${error.message}`) : error;
    }
  }

  #screenshotterFor(view: ViewConfig): Screenshotter {
    if (view.screenshotter !== undefined) return view.screenshotter;
    if (view.url !== undefined) return new UrlScreenshotter(view.url);
    throw new CaptureError(`view "${view.name}" has neither a url nor a screenshotter`);
  }

  async #readBaseline(ctx: RunContext, name: string): Promise<RgbaImage | null> {
    try {
      return decodePng(await readFile(this.#baselinePath(ctx, name)));
    } catch {
      // A missing baseline and an unreadable one recover the same way — record a
      // fresh one — so they are not worth telling apart here.
      return null;
    }
  }

  async #writeBaseline(ctx: RunContext, name: string, image: RgbaImage): Promise<void> {
    const target = this.#baselinePath(ctx, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, encodePng(image));
  }

  #compareOptions(): { tolerance?: number; maxRatio?: number } {
    return {
      ...(this.#options.tolerance !== undefined ? { tolerance: this.#options.tolerance } : {}),
      ...(this.#options.maxRatio !== undefined ? { maxRatio: this.#options.maxRatio } : {}),
    };
  }

  async #withServer<T>(ctx: RunContext, run: () => Promise<T>): Promise<T> {
    const server = this.#options.server;
    return server === undefined ? run() : withServer(server, ctx.repoRoot, run);
  }

  #baselineDir(ctx: RunContext): string {
    return join(ctx.repoRoot, this.#options.baselineDir ?? DEFAULT_BASELINE_DIR);
  }

  #baselinePath(ctx: RunContext, name: string): string {
    return join(this.#baselineDir(ctx), `${slug(name)}.png`);
  }
}

/** `home page @ 1280` → `home-page-1280`. Stable, and safe on every OS. */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'view'
  );
}
