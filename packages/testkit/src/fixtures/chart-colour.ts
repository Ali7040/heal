/**
 * Phase 5's fixture: an image endpoint whose colours went wrong.
 *
 * The bug is a copy-paste in a palette — two series that should be different
 * colours now render identically. Nothing throws, no exit code changes, and no
 * JSON anywhere is different: the endpoint returns a perfectly valid 200 PNG of
 * the wrong picture. Neither of the first two detector kinds can see it, which is
 * the entire reason a third one exists.
 *
 * The chart is drawn into a raw pixel buffer and encoded by hand, so the fixture
 * needs no canvas library and no browser. The regression is in the pixels either
 * way, and a fixture that required a 300 MB browser download to demonstrate a
 * colour mistake would be a worse fixture.
 *
 * It lives in its own file because the source below is program text, and holding
 * two nested layers of template literals in the shared registry made that file
 * hard to read for no benefit.
 */
import { IGNORED_ARTIFACTS } from '../artifacts.js';
import type { Fixture } from '../fixtures.js';

const PNG_MJS = `import { deflateSync } from 'node:zlib';

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, payload) {
  const out = Buffer.alloc(payload.length + 12);
  out.writeUInt32BE(payload.length, 0);
  out.write(type, 4, 'ascii');
  payload.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + payload.length)), 8 + payload.length);
  return out;
}

/** Encode an RGBA buffer as a PNG. No row filtering — simple beats small here. */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function blank(width, height, colour) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = colour[0];
    rgba[i * 4 + 1] = colour[1];
    rgba[i * 4 + 2] = colour[2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

export function fillRect(rgba, width, x0, y0, w, h, colour) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      const o = (y * width + x) * 4;
      rgba[o] = colour[0];
      rgba[o + 1] = colour[1];
      rgba[o + 2] = colour[2];
      rgba[o + 3] = 255;
    }
  }
}
`;

const CHART_MJS = `import { createServer } from 'node:http';

import { blank, encodePng, fillRect } from './png.mjs';

const PORT = Number(process.env.PORT ?? 8788);

const WIDTH = 240;
const HEIGHT = 120;
const BACKGROUND = [255, 255, 255];
const AXIS = [40, 40, 40];

// The brand palette. Every bar is drawn in one of these.
const BRAND = {
  revenue: [30, 120, 220],
  // BUG: refunds should be the brand amber [230, 160, 40]. Someone pasted the
  // revenue blue here instead, so both series render in the same colour. Nothing
  // throws, the endpoint still returns 200, and every test still passes.
  refunds: [30, 120, 220],
};

const SERIES = [
  { key: 'revenue', value: 70 },
  { key: 'refunds', value: 45 },
];

function renderChart() {
  const rgba = blank(WIDTH, HEIGHT, BACKGROUND);
  fillRect(rgba, WIDTH, 20, HEIGHT - 20, WIDTH - 40, 2, AXIS);

  SERIES.forEach((entry, index) => {
    const colour = BRAND[entry.key];
    const x = 40 + index * 90;
    fillRect(rgba, WIDTH, x, HEIGHT - 22 - entry.value, 60, entry.value, colour);
  });

  return encodePng(WIDTH, HEIGHT, rgba);
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', \`http://\${req.headers.host}\`);

  if (url.pathname === '/chart.png') {
    const png = renderChart();
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
    res.end(png);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}).listen(PORT, '127.0.0.1', () => {
  console.log(\`listening on \${PORT}\`);
});
`;

/**
 * The healthy palette, used to record the baseline the detector compares against.
 *
 * A visual fixture needs both pictures: the broken one the server ships, and the
 * correct one a human once approved. This is that second picture, expressed as the
 * one-line edit that produces it.
 */
export const CHART_FIXED_SOURCE = CHART_MJS.replace(
  `  // BUG: refunds should be the brand amber [230, 160, 40]. Someone pasted the
  // revenue blue here instead, so both series render in the same colour. Nothing
  // throws, the endpoint still returns 200, and every test still passes.
  refunds: [30, 120, 220],`,
  `  refunds: [230, 160, 40],`,
);

export const CHART_COLOUR_BUG: Fixture = {
  id: 'chart-colour-collision',
  description: 'A palette typo makes two chart series render in the same colour.',
  defect:
    'GET /chart.png draws the refunds bar in the revenue blue instead of the brand amber. The response is a valid 200 PNG, so nothing else notices.',
  files: {
    '.gitignore': IGNORED_ARTIFACTS,
    'png.mjs': PNG_MJS,
    'chart.mjs': CHART_MJS,
  },
  serve: {
    entry: 'chart.mjs',
    readyPath: '/chart.png',
    endpoints: [{ name: 'chart', path: '/chart.png' }],
  },
  editable: ['chart.mjs'],
  primary: 'chart.mjs',
};
