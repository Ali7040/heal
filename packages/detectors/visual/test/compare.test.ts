import { describe, expect, it } from 'vitest';

import { compareImages, renderDiffImage } from '../src/compare.js';
import type { RgbaImage } from '../src/png.js';

function canvas(width: number, height: number, rgb: [number, number, number] = [255, 255, 255]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set([...rgb, 255], i * 4);
  return { width, height, data };
}

function rect(image: RgbaImage, x0: number, y0: number, w: number, h: number, rgb: [number, number, number]): RgbaImage {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      image.data.set([...rgb, 255], (y * image.width + x) * 4);
    }
  }
  return image;
}

/** Nudge every pixel by a channel or two, the way antialiasing and JPEG-ish noise do. */
function jitter(image: RgbaImage, amount: number): RgbaImage {
  const copy: RgbaImage = { ...image, data: Uint8Array.from(image.data) };
  for (let i = 0; i < copy.data.length; i += 4) {
    copy.data[i] = Math.min(255, (copy.data[i] as number) + amount);
  }
  return copy;
}

describe('compareImages', () => {
  it('matches an image against itself', () => {
    const image = rect(canvas(40, 40), 5, 5, 10, 10, [30, 120, 220]);
    const result = compareImages(image, image);

    expect(result.matched).toBe(true);
    expect(result.diffPixels).toBe(0);
    expect(result.region).toBeNull();
  });

  it('ignores rendering noise below the tolerance', () => {
    // Antialiasing and GPU rounding move edge pixels by a couple of values between
    // two runs of identical code. Byte equality would report a regression on every
    // single run, and a detector that cries wolf gets switched off.
    const baseline = rect(canvas(40, 40), 5, 5, 10, 10, [30, 120, 220]);
    expect(compareImages(baseline, jitter(baseline, 6)).matched).toBe(true);
  });

  it('catches a colour change that keeps the layout identical', () => {
    // The phase-5 fixture's bug, in miniature: same shapes, wrong palette.
    const baseline = rect(canvas(40, 40), 5, 5, 20, 20, [230, 160, 40]);
    const actual = rect(canvas(40, 40), 5, 5, 20, 20, [30, 120, 220]);
    const result = compareImages(baseline, actual);

    expect(result.matched).toBe(false);
    expect(result.diffPixels).toBe(400);
    expect(result.region).toEqual({ x: 5, y: 5, width: 20, height: 20 });
  });

  it('reports where the change is, not just that there was one', () => {
    const baseline = canvas(60, 60);
    const actual = rect(canvas(60, 60), 40, 30, 8, 8, [0, 0, 0]);
    expect(compareImages(baseline, actual).region).toEqual({ x: 40, y: 30, width: 8, height: 8 });
  });

  it('treats a size change as a regression on its own terms', () => {
    // Comparing pixel-by-pixel across different dimensions would line up unrelated
    // positions and produce a meaningless ratio.
    const result = compareImages(canvas(40, 40), canvas(40, 60));
    expect(result.sizeChanged).toBe(true);
    expect(result.matched).toBe(false);
    expect(result.ratio).toBe(1);
  });

  it('lets a stray pixel through but not a stray region', () => {
    const baseline = canvas(100, 100);
    const speck = rect(canvas(100, 100), 0, 0, 3, 3, [0, 0, 0]);
    const blob = rect(canvas(100, 100), 0, 0, 30, 30, [0, 0, 0]);

    expect(compareImages(baseline, speck).matched).toBe(true); // 9 / 10000
    expect(compareImages(baseline, blob).matched).toBe(false); // 900 / 10000
  });

  it('rounds the ratio so the same regression keeps one identity', () => {
    // The ratio goes into the issue signature. An unrounded float would give the
    // same bug a new identity whenever a single pixel moved, and the journal, the
    // attempt cap, and the circuit breaker all key off that identity.
    const baseline = canvas(7, 7);
    const actual = rect(canvas(7, 7), 0, 0, 1, 1, [0, 0, 0]);
    expect(compareImages(baseline, actual).ratio).toBe(0.020408);
  });

  it('respects an explicit tolerance', () => {
    // Mid-grey, not white: `jitter` clamps at 255, so a white canvas would come
    // back identical and this would assert nothing.
    const baseline = canvas(20, 20, [100, 100, 100]);
    const shifted = jitter(baseline, 20);
    expect(compareImages(baseline, shifted, { tolerance: 30 }).matched).toBe(true);
    expect(compareImages(baseline, shifted, { tolerance: 5 }).matched).toBe(false);
  });
});

describe('renderDiffImage', () => {
  it('marks changed pixels in magenta and fades the rest', () => {
    const baseline = canvas(10, 10, [0, 0, 0]);
    const actual = rect(canvas(10, 10, [0, 0, 0]), 2, 2, 2, 2, [255, 255, 255]);
    const diff = renderDiffImage(baseline, actual);

    const at = (x: number, y: number) => Array.from(diff.data.subarray((y * 10 + x) * 4, (y * 10 + x) * 4 + 3));
    expect(at(2, 2)).toEqual([255, 0, 255]);
    expect(at(9, 9)).not.toEqual([255, 0, 255]);
  });

  it('covers both images when they are different sizes', () => {
    const diff = renderDiffImage(canvas(10, 10), canvas(14, 12));
    expect([diff.width, diff.height]).toEqual([14, 12]);
  });
});
