/**
 * The phase-5 deliverable: a visual regression, through the same engine.
 *
 * The second block runs a real `node chart.mjs` out of the fixture — a server that
 * renders a PNG — because the interesting assertions are about booting: a fix on
 * disk is only visible to `verify` if a fresh process is what answers it.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunContext } from '@self-heal/core/contracts/context';
import { silentLogger } from '@self-heal/core/logger';
import { CHART_FIXED_SOURCE, getFixture } from '@self-heal/testkit/fixtures';
import { Sandbox } from '@self-heal/testkit/sandbox';
import { freePort } from '@self-heal/testkit/server';
import { afterEach, describe, expect, it } from 'vitest';

import { MissingBaselineError, VisualDetector } from '../src/index.js';
import { encodePng, type RgbaImage } from '../src/png.js';
import { StaticScreenshotter } from '../src/capture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

function canvas(width: number, height: number, rgb: [number, number, number] = [255, 255, 255]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set([...rgb, 255], i * 4);
  return { width, height, data };
}

function withBox(rgb: [number, number, number]): RgbaImage {
  const image = canvas(40, 40);
  for (let y = 5; y < 25; y += 1) {
    for (let x = 5; x < 25; x += 1) image.data.set([...rgb, 255], (y * 40 + x) * 4);
  }
  return image;
}

async function workspace(): Promise<{ root: string; ctx: RunContext }> {
  const root = await mkdtemp(join(tmpdir(), 'self-heal-visual-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    ctx: {
      repoRoot: root,
      evidenceDir: join(root, '.self-heal/evidence'),
      dryRun: false,
      config: {},
      log: silentLogger,
    },
  };
}

/** A view whose pixels come from a variable, so a test can change what it renders. */
function view(name: string, current: { image: RgbaImage }) {
  return { name, screenshotter: new StaticScreenshotter(() => encodePng(current.image)), editable: ['ui.mjs'] };
}

describe('VisualDetector', () => {
  it('records a baseline the first time it sees a view, and reports nothing', async () => {
    const { root, ctx } = await workspace();
    const current = { image: withBox([230, 160, 40]) };
    const detector = new VisualDetector({ views: [view('chart', current)] });

    expect(await detector.detect(ctx)).toEqual([]);
    // Nothing to compare against yet. An issue here would mean every new view
    // looks broken on the day it is added.
    const written = await readFile(join(root, '.self-heal/baselines/chart.png'));
    expect(written.length).toBeGreaterThan(8);
  });

  it('says nothing when the picture has not changed', async () => {
    const { ctx } = await workspace();
    const current = { image: withBox([230, 160, 40]) };
    const detector = new VisualDetector({ views: [view('chart', current)] });

    await detector.detect(ctx);
    expect(await detector.detect(ctx)).toEqual([]);
  });

  it('catches a colour change that leaves the layout untouched', async () => {
    const { ctx } = await workspace();
    const current = { image: withBox([230, 160, 40]) };
    const detector = new VisualDetector({ views: [view('chart', current)] });
    await detector.detect(ctx);

    current.image = withBox([30, 120, 220]);
    const [issue] = await detector.detect(ctx);

    expect(issue?.kind).toBe('visual-regression');
    expect(issue?.location).toEqual({ selector: 'chart', file: 'ui.mjs' });
    expect((issue?.actual as { region: unknown }).region).toEqual({ x: 5, y: 5, width: 20, height: 20 });
  });

  it('keeps one signature for the same regression across runs', async () => {
    const { ctx } = await workspace();
    const current = { image: withBox([230, 160, 40]) };
    const detector = new VisualDetector({ views: [view('chart', current)] });
    await detector.detect(ctx);

    current.image = withBox([30, 120, 220]);
    const first = (await detector.detect(ctx))[0];
    const second = (await detector.detect(ctx))[0];

    expect(second?.signature).toBe(first?.signature);
  });

  it('writes expected, actual, and diff images, and no pixels into the issue', async () => {
    const { ctx } = await workspace();
    const current = { image: withBox([230, 160, 40]) };
    const detector = new VisualDetector({ views: [view('chart', current)] });
    await detector.detect(ctx);

    current.image = withBox([30, 120, 220]);
    const [issue] = await detector.detect(ctx);

    expect(issue?.evidence.map((ref) => ref.path)).toEqual([
      'visual/chart.expected.png',
      'visual/chart.actual.png',
      'visual/chart.diff.png',
    ]);
    for (const ref of issue?.evidence ?? []) {
      expect((await readFile(join(ctx.evidenceDir, ref.path))).length).toBeGreaterThan(8);
    }
    // An `Issue` is hashed, logged, journalled, and summarised into a prompt. A
    // pixel buffer must never ride along.
    expect(JSON.stringify(issue).length).toBeLessThan(2000);
  });

  it('treats a size change as a regression', async () => {
    const { ctx } = await workspace();
    const current = { image: canvas(40, 40) };
    const detector = new VisualDetector({ views: [view('chart', current)] });
    await detector.detect(ctx);

    current.image = canvas(40, 60);
    const [issue] = await detector.detect(ctx);
    expect((issue?.actual as { sizeChanged: boolean }).sizeChanged).toBe(true);
  });

  it('reports a capture that fails rather than throwing mid-run', async () => {
    const { ctx } = await workspace();
    const current = { image: withBox([230, 160, 40]) };
    const detector = new VisualDetector({ views: [view('chart', current)] });
    await detector.detect(ctx);

    const broken = new VisualDetector({
      views: [{ name: 'chart', screenshotter: new StaticScreenshotter(() => new Uint8Array([1, 2, 3])), editable: ['ui.mjs'] }],
    });
    const [issue] = await broken.detect(ctx);

    // A page that now renders nothing is a regression a fixer can often act on.
    expect((issue?.actual as { capture: string }).capture).toBe('failed');
  });

  it('refuses to record a baseline silently when told not to', async () => {
    const { ctx } = await workspace();
    const current = { image: withBox([230, 160, 40]) };
    const detector = new VisualDetector({ views: [view('chart', current)], record: 'never' });

    await expect(detector.detect(ctx)).rejects.toBeInstanceOf(MissingBaselineError);
  });

  it('cannot be talked into verifying an issue whose baseline was deleted', async () => {
    const { root, ctx } = await workspace();
    const current = { image: withBox([230, 160, 40]) };
    const detector = new VisualDetector({ views: [view('chart', current)] });
    await detector.detect(ctx);

    current.image = withBox([30, 120, 220]);
    const [issue] = await detector.detect(ctx);

    await rm(join(root, '.self-heal/baselines/chart.png'));
    // Otherwise deleting a baseline would be a way to "fix" any regression.
    expect(await detector.verify(issue!, ctx)).toBe(false);
  });
});

describe('VisualDetector against a real rendering server', () => {
  it('detects the palette bug, and reports healed only once the code changes', async () => {
    const fixture = getFixture('chart-colour-collision');
    // The baseline has to come from the *correct* chart, so the sandbox starts
    // healthy, records, and then the regression lands — which is how this happens
    // in a real repository.
    const sandbox = await Sandbox.create({
      files: { ...fixture.files, 'chart.mjs': CHART_FIXED_SOURCE },
      prefix: 'self-heal-visual-e2e-',
    });
    cleanups.push(() => sandbox.dispose());

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const detector = new VisualDetector({
      id: 'chart-ui',
      views: [{ name: 'chart', url: `${base}/chart.png`, editable: ['chart.mjs'] }],
      server: {
        command: process.execPath,
        args: [fixture.serve!.entry],
        readyUrl: `${base}${fixture.serve!.readyPath}`,
        env: { PORT: String(port) },
      },
    });

    const ctx: RunContext = {
      repoRoot: sandbox.dir,
      evidenceDir: join(sandbox.dir, '.self-heal/evidence'),
      dryRun: false,
      config: {},
      log: silentLogger,
    };

    expect(await detector.detect(ctx)).toEqual([]); // records the good picture

    await writeFile(join(sandbox.dir, 'chart.mjs'), fixture.files['chart.mjs'] as string, 'utf8');
    const [issue] = await detector.detect(ctx);
    expect(issue?.kind).toBe('visual-regression');

    // Nothing has changed on disk since, so the answer must still be no.
    expect(await detector.verify(issue!, ctx)).toBe(false);

    await writeFile(join(sandbox.dir, 'chart.mjs'), CHART_FIXED_SOURCE, 'utf8');
    // Only visible because `verify` boots a fresh process: the old one is still
    // holding the old palette in memory (D-011).
    expect(await detector.verify(issue!, ctx)).toBe(true);
  });
});
