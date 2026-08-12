/**
 * A registry of deliberately broken programs.
 *
 * Each fixture is a self-contained repository plus a way to measure it — a `check`
 * command whose exit code decides health, or a `serve` block describing a server
 * that has to be booted and asked. The second shape arrived with phase 2, and the
 * split is the point: a defect that is invisible to an exit code is exactly what a
 * second detector kind exists for.
 *
 * Adding a fixture is a data change, not a code change. Phase 5's
 * visual-regression fixture lands here as another entry, and every existing
 * harness, script, and test can use it immediately — `scripts/demo.mjs` picks its
 * detector from the fixture's shape rather than from a flag.
 */
export interface Fixture {
  readonly id: string;
  readonly description: string;
  /** Repository-relative path → contents. */
  readonly files: Readonly<Record<string, string>>;
  /**
   * Command that measures the repo. Exit 0 = healthy.
   *
   * Optional since phase 2: not every defect is observable from an exit code.
   * A dropped API field is only visible by starting the server and asking it —
   * which is the whole reason a second detector kind exists.
   */
  readonly check?: { readonly command: string; readonly args: readonly string[] };
  /** A long-running server this fixture must boot before it can be measured. */
  readonly serve?: {
    readonly entry: string;
    /** Path polled until it answers, and the endpoint under contract. */
    readonly readyPath: string;
    readonly endpoints: readonly { readonly name: string; readonly path: string }[];
  };
  /** Files a fixer is allowed to edit — the allowlist for this fixture. */
  readonly editable: readonly string[];
  /** The file that actually contains the defect. Concrete, never a glob. */
  readonly primary: string;
  /** Human-readable statement of the defect, for prompts and reports. */
  readonly defect: string;
}

const PRICING_BUG: Fixture = {
  id: 'pricing-tax-ignored',
  description: 'A pure function accepts a tax rate and silently ignores it.',
  defect: 'totalWithTax() returns the pre-tax amount for every input.',
  files: {
    'src/pricing.mjs': `export function totalWithTax(cents, rate) {
  // BUG: the tax rate is accepted and then ignored.
  return cents;
}
`,
    'check.mjs': `import { totalWithTax } from './src/pricing.mjs';

const cases = [
  [1000, 0.1, 1100],
  [0, 0.2, 0],
  [2550, 0.08, 2754],
];

let failed = 0;
for (const [cents, rate, expected] of cases) {
  const actual = totalWithTax(cents, rate);
  if (actual !== expected) {
    console.error(\`FAIL totalWithTax(\${cents}, \${rate}) => \${actual}, expected \${expected}\`);
    failed += 1;
  }
}

if (failed > 0) {
  console.error(\`\${failed} of \${cases.length} cases failed\`);
  process.exit(1);
}
console.log('ok');
`,
  },
  check: { command: process.execPath, args: ['check.mjs'] },
  editable: ['src/**/*.mjs'],
  primary: 'src/pricing.mjs',
};

/**
 * Phase 2's fixture: an API that quietly stopped returning a field.
 *
 * This is the regression schema tooling exists for. Nothing throws, nothing exits
 * non-zero, the endpoint returns 200, and the test suite — if there is one —
 * keeps passing. The only way to notice is to compare the response against what
 * it used to look like, which is exactly what the recorded contract below is for.
 *
 * The contract file ships with the fixture and is committed like any other source
 * file. That is the intended workflow: a human reviewed the shape once, and every
 * run afterwards is machinery noticing when reality stops matching it.
 */
const ORDERS_CONTRACT_BUG: Fixture = {
  id: 'orders-total-dropped',
  description: 'An API handler stops returning a field it has always returned.',
  defect: 'GET /api/orders omits `total` from every order. The response is still a valid 200.',
  files: {
    'api.mjs': `import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);

const orders = [
  { id: 1, customer: 'ada', total: 1299, currency: 'usd' },
  { id: 2, customer: 'grace', total: 4500, currency: 'usd' },
  { id: 3, customer: 'katherine', total: 890, currency: 'usd' },
];

function listOrders() {
  // BUG: \`total\` is dropped from the projection. The response is still a
  // well-formed 200, so nothing crashes and no exit code changes.
  return orders.map(({ id, customer, currency }) => ({ id, customer, currency }));
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', \`http://\${req.headers.host}\`);

  if (url.pathname === '/api/orders') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ orders: listOrders() }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}).listen(PORT, '127.0.0.1', () => {
  console.log(\`listening on \${PORT}\`);
});
`,
    '.self-heal/contracts/get-api-orders.json': `{
  "endpoint": "GET /api/orders",
  "status": 200,
  "shape": {
    "$": { "type": "object" },
    "$.orders": { "type": "array" },
    "$.orders[]": { "type": "object" },
    "$.orders[].currency": { "type": "string" },
    "$.orders[].customer": { "type": "string" },
    "$.orders[].id": { "type": "number" },
    "$.orders[].total": { "type": "number" }
  },
  "recordedAt": "2026-01-01T00:00:00.000Z"
}
`,
  },
  serve: {
    entry: 'api.mjs',
    readyPath: '/api/orders',
    endpoints: [{ name: 'GET /api/orders', path: '/api/orders' }],
  },
  editable: ['api.mjs'],
  primary: 'api.mjs',
};

export const FIXTURES: Readonly<Record<string, Fixture>> = {
  [PRICING_BUG.id]: PRICING_BUG,
  [ORDERS_CONTRACT_BUG.id]: ORDERS_CONTRACT_BUG,
};

export function getFixture(id: string): Fixture {
  const fixture = FIXTURES[id];
  if (fixture === undefined) {
    throw new Error(`unknown fixture "${id}". Available: ${Object.keys(FIXTURES).join(', ')}`);
  }
  return fixture;
}
