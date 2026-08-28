import { describe, expect, it } from 'vitest';

import { decodePng, encodePng, isPng, PngError, type RgbaImage } from '../src/png.js';

function solid(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set(rgba, i * 4);
  return { width, height, data };
}

describe('png', () => {
  it('round-trips an image through encode and decode', () => {
    const original = solid(9, 7, [12, 200, 90, 255]);
    const decoded = decodePng(encodePng(original));

    expect(decoded.width).toBe(9);
    expect(decoded.height).toBe(7);
    // Byte-exact, not approximately: this codec is the measuring instrument, and
    // an instrument that rounds would invent visual regressions.
    expect(Buffer.from(decoded.data)).toEqual(Buffer.from(original.data));
  });

  it('preserves an alpha channel', () => {
    const decoded = decodePng(encodePng(solid(3, 3, [10, 20, 30, 128])));
    expect(decoded.data[3]).toBe(128);
  });

  it('handles a single pixel and a tall thin image', () => {
    expect(decodePng(encodePng(solid(1, 1, [1, 2, 3, 4]))).data).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(decodePng(encodePng(solid(1, 64, [5, 6, 7, 255]))).height).toBe(64);
  });

  it('decodes rows that vary, not just flat colour', () => {
    // A flat image survives every filter bug ever written. This one does not.
    const image = solid(4, 4, [0, 0, 0, 255]);
    for (let i = 0; i < 16; i += 1) {
      image.data[i * 4] = i * 16;
      image.data[i * 4 + 1] = 255 - i * 16;
    }
    expect(Buffer.from(decodePng(encodePng(image)).data)).toEqual(Buffer.from(image.data));
  });

  it('recognises a PNG by its signature', () => {
    expect(isPng(encodePng(solid(2, 2, [0, 0, 0, 255])))).toBe(true);
    expect(isPng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(false);
    expect(isPng(new Uint8Array([]))).toBe(false);
  });

  it('refuses a file it cannot decode instead of guessing', () => {
    // Silently mis-decoding would surface later as a phantom visual regression,
    // which is the one failure mode this project must not produce.
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(PngError);
  });

  it('rejects a truncated file', () => {
    const encoded = encodePng(solid(8, 8, [9, 9, 9, 255]));
    expect(() => decodePng(encoded.subarray(0, encoded.length - 20))).toThrow(PngError);
  });
});
