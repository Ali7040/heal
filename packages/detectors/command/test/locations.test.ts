/**
 * Real output shapes from the tools people actually point a command check at.
 * Each must turn into a repo-relative `file:line` — and anything that is not a
 * file in the repository must not.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { Sandbox } from '@self-heal/testkit/sandbox';

import { CommandDetector } from '../src/index.js';
import { findLocations } from '../src/locations.js';
import type { RunContext } from '@self-heal/core/contracts/context';
import { silentLogger } from '@self-heal/core/logger';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  await sandbox?.dispose();
  sandbox = undefined;
});

const FILES = {
  'src/cart.ts': 'export const total = 1;\n',
  'src/cart.test.ts': 'test();\n',
  'app/models.py': 'x = 1\n',
  'tests/test_models.py': 'def test(): pass\n',
  'pkg/cart.go': 'package pkg\n',
  'src/main.rs': 'fn main() {}\n',
};

async function repo(): Promise<Sandbox> {
  sandbox = await Sandbox.create({ files: FILES, prefix: 'locations-test-' });
  return sandbox;
}

async function find(output: string, editable: readonly string[] = []) {
  const box = sandbox ?? (await repo());
  return (await findLocations(output, { repoRoot: box.dir, editable })).map((l) => `${l.file}:${l.line}`);
}

describe('findLocations', () => {
  it('reads tsc, in both its formats', async () => {
    expect(await find("src/cart.ts(12,5): error TS2322: Type 'string' is not assignable")).toEqual(['src/cart.ts:12']);
    expect(await find('src/cart.ts:14:3 - error TS2304: Cannot find name')).toEqual(['src/cart.ts:14']);
  });

  it("reads eslint's stylish format, where the path and the line are on different lines", async () => {
    const box = await repo();
    const output = [`${box.dir}/src/cart.ts`, '  3:7   error  x is never reassigned  prefer-const', '  9:1   warning  Unexpected console  no-console', ''].join('\n');
    expect(await find(output)).toEqual(['src/cart.ts:3', 'src/cart.ts:9']);
  });

  it('reads a vitest failure, and ranks the editable source above the test that noticed', async () => {
    const output = [
      ' FAIL  src/cart.test.ts > total',
      'AssertionError: expected 1 to be 2',
      ' ❯ src/cart.test.ts:8:18',
      '    at total (src/cart.ts:1:14)',
    ].join('\n');
    expect(await find(output, ['src/**/*.ts'])).toEqual(['src/cart.test.ts:8', 'src/cart.ts:1']);
    expect(await find(output, ['src/cart.ts'])).toEqual(['src/cart.ts:1', 'src/cart.test.ts:8']);
  });

  it('reads a Python traceback and a pytest summary line', async () => {
    const output = [
      'Traceback (most recent call last):',
      '  File "app/models.py", line 4, in load',
      'tests/test_models.py:12: AssertionError',
    ].join('\n');
    expect(await find(output)).toEqual(['app/models.py:4', 'tests/test_models.py:12']);
  });

  it('reads go and rustc', async () => {
    expect(await find('./pkg/cart.go:21:2: undefined: Total')).toEqual(['pkg/cart.go:21']);
    expect(await find('error[E0425]: cannot find value\n  --> src/main.rs:2:5')).toEqual(['src/main.rs:2']);
  });

  it('makes absolute paths into the repository relative — Windows ones included', async () => {
    const box = await repo();
    const windows = box.dir.replace(/\//g, '\\');
    expect(await find(`    at total (${windows}\\src\\cart.ts:1:14)`)).toEqual(['src/cart.ts:1']);
    expect(await find(`    at total (file://${box.dir.replace(/\\/g, '/')}/src/cart.ts:1:14)`)).toEqual(['src/cart.ts:1']);
  });

  it('drops what is not a file in this repository', async () => {
    const output = [
      'Server on http://127.0.0.1:3000',
      'at Module._compile (node:internal/modules/cjs/loader.js:1105:14)',
      'at run (node_modules/vitest/dist/index.js:40:3)',
      'src/missing.ts:3:1 error',
      'Duration 1.23s (transform 12ms)',
    ].join('\n');
    expect(await find(output)).toEqual([]);
  });

  it('keeps each place once, and at most a handful', async () => {
    const output = Array.from({ length: 20 }, (_, i) => `src/cart.ts:${(i % 8) + 1}:1 error`).join('\n');
    expect(await find(output)).toEqual(['src/cart.ts:1', 'src/cart.ts:2', 'src/cart.ts:3', 'src/cart.ts:4', 'src/cart.ts:5']);
  });
});

describe('CommandDetector', () => {
  function contextFor(dir: string): RunContext {
    return { repoRoot: dir, evidenceDir: `${dir}/.self-heal/evidence`, dryRun: false, config: {}, log: silentLogger };
  }

  function failingWith(output: string) {
    return new CommandDetector({
      id: 'check',
      command: process.execPath,
      args: ['-e', `process.stderr.write(${JSON.stringify(output)}); process.exit(1)`],
      editable: ['src/**'],
    });
  }

  it('attaches where the output points, without letting it change the identity', async () => {
    const box = await repo();
    const [first] = await failingWith('error: src/cart.ts:1:14 wrong total\n').detect(contextFor(box.dir));
    // The same failure after an unrelated edit moved it down a line.
    const [moved] = await failingWith('error: src/cart.ts:2:14 wrong total\n').detect(contextFor(box.dir));

    expect(first?.related).toEqual([{ file: 'src/cart.ts', line: 1 }]);
    expect(moved?.related).toEqual([{ file: 'src/cart.ts', line: 2 }]);
    expect(moved?.signature).toBe(first?.signature);
  });
});
