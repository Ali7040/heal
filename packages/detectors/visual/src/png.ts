/**
 * A PNG reader and writer, in about two hundred lines of Node builtins.
 *
 * Writing this rather than depending on `pngjs` or `sharp` is a deliberate trade,
 * and the reason is the same one behind `node:sqlite` in the journal (D-013): the
 * usual image libraries are native modules that compile on install, and a tool
 * whose `npm install` can fail on a missing compiler is one people abandon before
 * they ever see it work. A visual detector that cannot be installed detects
 * nothing.
 *
 * The scope is deliberately narrow — 8-bit RGB and RGBA, non-interlaced, which is
 * what every screenshot tool and canvas encoder emits. Anything else is refused
 * with a message that says what it found, rather than decoded incorrectly. A
 * wrong pixel buffer would surface much later as a phantom visual regression,
 * which is exactly the kind of failure this project exists not to produce.
 */
import { deflateSync, inflateSync } from 'node:zlib';

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA, 4 bytes per pixel. Always RGBA, even if the file was RGB. */
  readonly data: Uint8Array;
}

export class PngError extends Error {}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.equals(Buffer.from(bytes.subarray(0, 8)));
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  const buffer = Buffer.from(bytes);
  if (!isPng(buffer)) throw new PngError('not a PNG (bad signature)');

  let offset = 8;
  let header: { width: number; height: number; depth: number; colorType: number } | undefined;
  const idat: Buffer[] = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) throw new PngError(`truncated PNG: chunk ${type} claims ${length} bytes`);

    if (type === 'IHDR') {
      const depth = buffer.readUInt8(start + 8);
      const colorType = buffer.readUInt8(start + 9);
      const interlace = buffer.readUInt8(start + 12);
      if (depth !== 8) throw new PngError(`unsupported PNG bit depth ${depth} (only 8 is handled)`);
      if (colorType !== 2 && colorType !== 6) {
        throw new PngError(`unsupported PNG colour type ${colorType} (only 2=RGB and 6=RGBA are handled)`);
      }
      if (interlace !== 0) throw new PngError('interlaced PNGs are not handled');
      header = { width: buffer.readUInt32BE(start), height: buffer.readUInt32BE(start + 4), depth, colorType };
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }

    // 4 bytes of chunk CRC follow the payload. Not verified: a corrupt file shows
    // up as a decode failure anyway, and re-checking every byte on a screenshot
    // costs more than it catches.
    offset = end + 4;
  }

  if (header === undefined) throw new PngError('PNG has no IHDR chunk');
  if (idat.length === 0) throw new PngError('PNG has no image data');

  const raw = inflateSync(Buffer.concat(idat));
  return unfilter(raw, header.width, header.height, header.colorType === 6 ? 4 : 3);
}

/**
 * Undo PNG's per-scanline filters.
 *
 * Each row is prefixed with a filter byte saying how it was encoded relative to
 * the row above and the pixel to the left. This is the whole reason a PNG cannot
 * simply be inflated into a pixel buffer, and getting it wrong produces an image
 * that looks plausibly smeared rather than obviously broken.
 */
function unfilter(raw: Buffer, width: number, height: number, channels: number): RgbaImage {
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (raw.length < expected) {
    throw new PngError(`PNG data is short: expected ${expected} bytes after inflate, got ${raw.length}`);
  }

  const out = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart] as number;
    raw.copy(current, 0, rowStart + 1, rowStart + 1 + stride);

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? (current[x - channels] as number) : 0;
      const up = previous[x] as number;
      const upLeft = x >= channels ? (previous[x - channels] as number) : 0;
      const value = current[x] as number;

      switch (filter) {
        case 0:
          break;
        case 1:
          current[x] = (value + left) & 0xff;
          break;
        case 2:
          current[x] = (value + up) & 0xff;
          break;
        case 3:
          current[x] = (value + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          current[x] = (value + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new PngError(`unknown PNG row filter ${filter} on row ${y}`);
      }
    }

    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      out[to] = current[from] as number;
      out[to + 1] = current[from + 1] as number;
      out[to + 2] = current[from + 2] as number;
      // An RGB source is opaque by definition; normalising to RGBA here means
      // everything downstream handles exactly one pixel layout.
      out[to + 3] = channels === 4 ? (current[from + 3] as number) : 255;
    }

    previous.set(current);
  }

  return { width, height, data: out };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Encodes RGBA with no row filtering — larger files, far simpler to be sure of. */
export function encodePng(image: RgbaImage): Uint8Array {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, payload: Buffer): Buffer {
  const out = Buffer.alloc(payload.length + 12);
  out.writeUInt32BE(payload.length, 0);
  out.write(type, 4, 'ascii');
  payload.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + payload.length)), 8 + payload.length);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = -1;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
