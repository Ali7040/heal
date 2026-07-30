/**
 * A registry of deliberately broken programs.
 *
 * Each fixture is a self-contained repository plus a `check` command that
 * measures it: exit 0 means healthy, non-zero means broken. That shape is
 * deliberate — it is the smallest possible stand-in for a `Detector`, so an
 * experiment can exercise the full detect → fix → verify cycle before any real
 * detector exists.
 *
 * Adding a fixture is a data change, not a code change. Phase 2's schema-drift
 * fixture and phase 5's visual-regression fixture land here as new entries and
 * every existing harness, script, and test can use them immediately.
 */
export interface Fixture {
  readonly id: string;
  readonly description: string;
  /** Repository-relative path → contents. */
  readonly files: Readonly<Record<string, string>>;
  /** Command that measures the repo. Exit 0 = healthy. */
  readonly check: { readonly command: string; readonly args: readonly string[] };
  /** Files a fixer is allowed to edit — the allowlist for this fixture. */
  readonly editable: readonly string[];
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
};

export const FIXTURES: Readonly<Record<string, Fixture>> = {
  [PRICING_BUG.id]: PRICING_BUG,
};

export function getFixture(id: string): Fixture {
  const fixture = FIXTURES[id];
  if (fixture === undefined) {
    throw new Error(`unknown fixture "${id}". Available: ${Object.keys(FIXTURES).join(', ')}`);
  }
  return fixture;
}
