/**
 * What counts as a visual regression.
 *
 * The naive answer — any pixel that differs — is useless in practice. Antialiasing,
 * font hinting, and GPU rounding move a handful of edge pixels by a couple of
 * values between two runs of *identical* code, so byte equality reports a
 * regression on every run and the detector gets switched off within a day. That is
 * the same failure mode D-010 avoids for schema drift, arriving through a
 * different door.
 *
 * So there are two thresholds, and they do different jobs:
 *
 *   `tolerance`  how different one pixel must be before it counts at all.
 *                Absorbs antialiasing and compression noise.
 *   `maxRatio`   how much of the image may count before it is a regression.
 *                Absorbs a stray cursor or a scrollbar.
 *
 * Both default to values that ignore rendering noise and still catch anything a
 * person would notice. Neither can hide a real change: a shifted layout or a wrong
 * colour moves thousands of pixels well past any sane threshold.
 */
import type { RgbaImage } from './png.js';

export interface CompareOptions {
  /** 0-255 per-channel distance below which two pixels are "the same". */
  readonly tolerance?: number;
  /** Fraction of differing pixels tolerated before this is a regression. */
  readonly maxRatio?: number;
}

export interface Comparison {
  readonly matched: boolean;
  readonly diffPixels: number;
  readonly totalPixels: number;
  /** `diffPixels / totalPixels`, rounded to six places so it hashes stably. */
  readonly ratio: number;
  /** Bounding box of everything that differed, or null if nothing did. */
  readonly region: { x: number; y: number; width: number; height: number } | null;
  readonly sizeChanged: boolean;
}

export const DEFAULT_TOLERANCE = 12;
export const DEFAULT_MAX_RATIO = 0.001;

export function compareImages(baseline: RgbaImage, actual: RgbaImage, options: CompareOptions = {}): Comparison {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const maxRatio = options.maxRatio ?? DEFAULT_MAX_RATIO;

  // A size change is a regression on its own terms, and comparing pixel-by-pixel
  // across different dimensions would compare unrelated positions and report a
  // meaningless ratio.
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return {
      matched: false,
      diffPixels: actual.width * actual.height,
      totalPixels: baseline.width * baseline.height,
      ratio: 1,
      region: { x: 0, y: 0, width: actual.width, height: actual.height },
      sizeChanged: true,
    };
  }

  const totalPixels = baseline.width * baseline.height;
  let diffPixels = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;

  for (let index = 0; index < totalPixels; index += 1) {
    const offset = index * 4;
    if (!differs(baseline.data, actual.data, offset, tolerance)) continue;

    diffPixels += 1;
    const x = index % baseline.width;
    const y = (index / baseline.width) | 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  const ratio = totalPixels === 0 ? 0 : round(diffPixels / totalPixels);

  return {
    matched: ratio <= maxRatio,
    diffPixels,
    totalPixels,
    ratio,
    region: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    sizeChanged: false,
  };
}

/**
 * Per-channel distance, not Euclidean.
 *
 * A pixel counts as changed if *any* channel moved past the tolerance, so a pure
 * colour shift — red to orange, brand blue to the wrong blue — is caught even
 * though the overall distance is modest. Euclidean distance would let exactly that
 * class of regression slip under a threshold set loose enough for antialiasing.
 */
function differs(a: Uint8Array, b: Uint8Array, offset: number, tolerance: number): boolean {
  return (
    Math.abs((a[offset] as number) - (b[offset] as number)) > tolerance ||
    Math.abs((a[offset + 1] as number) - (b[offset + 1] as number)) > tolerance ||
    Math.abs((a[offset + 2] as number) - (b[offset + 2] as number)) > tolerance ||
    Math.abs((a[offset + 3] as number) - (b[offset + 3] as number)) > tolerance
  );
}

/**
 * A human-readable diff image: the baseline, dimmed, with changes in magenta.
 *
 * This is evidence for a person, not an input to anything — nothing downstream
 * reads it back. It exists because "0.8% of pixels differ" tells you a regression
 * happened and nothing about what, and the first thing anyone does with a failing
 * visual check is look at it.
 */
export function renderDiffImage(baseline: RgbaImage, actual: RgbaImage, tolerance = DEFAULT_TOLERANCE): RgbaImage {
  const width = Math.max(baseline.width, actual.width);
  const height = Math.max(baseline.height, actual.height);
  const data = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const to = (y * width + x) * 4;
      const inBaseline = x < baseline.width && y < baseline.height;
      const inActual = x < actual.width && y < actual.height;

      if (inBaseline && inActual) {
        const from = (y * baseline.width + x) * 4;
        const at = (y * actual.width + x) * 4;
        if (channelDiffers(baseline.data, from, actual.data, at, tolerance)) {
          paint(data, to, 255, 0, 255);
        } else {
          // Unchanged pixels are washed out so the magenta reads at a glance.
          const grey = Math.round(
            ((baseline.data[from] as number) + (baseline.data[from + 1] as number) + (baseline.data[from + 2] as number)) / 3,
          );
          const faded = Math.round(255 - (255 - grey) * 0.25);
          paint(data, to, faded, faded, faded);
        }
        continue;
      }

      // Outside one image or the other — a size change. Marked, not ignored.
      paint(data, to, inActual ? 255 : 80, 0, inActual ? 255 : 80);
    }
  }

  return { width, height, data };
}

function channelDiffers(a: Uint8Array, aOffset: number, b: Uint8Array, bOffset: number, tolerance: number): boolean {
  for (let channel = 0; channel < 4; channel += 1) {
    if (Math.abs((a[aOffset + channel] as number) - (b[bOffset + channel] as number)) > tolerance) return true;
  }
  return false;
}

function paint(data: Uint8Array, offset: number, r: number, g: number, b: number): void {
  data[offset] = r;
  data[offset + 1] = g;
  data[offset + 2] = b;
  data[offset + 3] = 255;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
