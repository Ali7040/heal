import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { matches } from '@self-heal/core/safety/allowlist';

import {
  ConfigError,
  DEFAULT_PROTECTED,
  DEFAULT_SANDBOX_EXCLUDE,
  inferPriority,
  LINT_PRIORITY,
  loadConfig,
  ROOT_CAUSE_PRIORITY,
  SYMPTOM_PRIORITY,
} from '../src/config.js';

let dir: string | undefined;

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function configWith(extra: Record<string, unknown>) {
  dir = await mkdtemp(join(tmpdir(), 'config-test-'));
  const body = { checks: [{ id: 't', command: 'npm', args: ['test'], editable: ['src/**'] }], allowlist: ['src/**'], ...extra };
  await writeFile(join(dir, 'self-heal.config.json'), JSON.stringify(body));
  return loadConfig('self-heal.config.json', dir);
}

describe('protected paths in config', () => {
  it('protects common test layouts by default, and the config file itself', async () => {
    const config = await configWith({});
    expect(config.protected).toEqual([...DEFAULT_PROTECTED, 'self-heal.config.json']);
  });

  it('lets a config replace the defaults, but never unprotect itself', async () => {
    const config = await configWith({ protected: [] });
    expect(config.protected).toEqual(['self-heal.config.json']);
  });

  it('confirms a failure once by default, and refuses a nonsense count', async () => {
    expect((await configWith({})).confirmFailures).toBe(1);
    expect((await configWith({ confirmFailures: 0 })).confirmFailures).toBe(0);
    await expect(configWith({ confirmFailures: -1 })).rejects.toBeInstanceOf(ConfigError);
    await expect(configWith({ confirmFailures: 1.5 })).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects a protected value that is not a list', async () => {
    await expect(configWith({ protected: '**/*.test.*' })).rejects.toBeInstanceOf(ConfigError);
  });

  it('covers the usual test file layouts, and not source that merely mentions "test"', () => {
    const covered = (path: string) => DEFAULT_PROTECTED.some((glob) => matches(path, glob));
    for (const path of ['a.test.ts', 'src/a.spec.js', 'pkg/x_test.go', 'test_x.py', 'src/__tests__/a.js', 'test/a.js', 'py/tests/a.py']) {
      expect(covered(path), path).toBe(true);
    }
    expect(covered('src/testing.ts')).toBe(false);
    expect(covered('src/latest.ts')).toBe(false);
  });

  it('keeps secrets out by default, and lets a config add to the list but never remove from it', async () => {
    expect((await configWith({})).sandboxExclude).toEqual([...DEFAULT_SANDBOX_EXCLUDE]);
    const added = await configWith({ sandboxExclude: ['secrets/**'] });
    expect(added.sandboxExclude).toEqual([...DEFAULT_SANDBOX_EXCLUDE, 'secrets/**']);
    // An empty list is not an opt-out.
    expect((await configWith({ sandboxExclude: [] })).sandboxExclude).toEqual([...DEFAULT_SANDBOX_EXCLUDE]);
    await expect(configWith({ sandboxExclude: '.env' })).rejects.toBeInstanceOf(ConfigError);
  });

  it('covers the usual secret files, and not ordinary source', () => {
    const excluded = (path: string) => DEFAULT_SANDBOX_EXCLUDE.some((glob) => matches(path, glob));
    for (const path of ['.env', 'app/.env.production', 'certs/server.pem', 'tls.key', 'deploy/id_rsa', '.npmrc']) {
      expect(excluded(path), path).toBe(true);
    }
    for (const path of ['src/env.ts', 'src/keys.ts', 'src/monkey.js', 'docs/environment.md']) {
      expect(excluded(path), path).toBe(false);
    }
  });

  it('runs only verified harnesses unless told otherwise', async () => {
    expect((await configWith({})).allowUnverifiedHarness).toBe(false);
    expect((await configWith({ allowUnverifiedHarness: true })).allowUnverifiedHarness).toBe(true);
  });

  it('orders checks root cause first, guessing from the command when not told', () => {
    const guess = (id: string, command: string, ...args: string[]) => inferPriority({ id, command, args });
    expect(guess('types', 'npx', 'tsc', '--noEmit')).toBe(ROOT_CAUSE_PRIORITY);
    expect(guess('build', 'npm', 'run', 'build')).toBe(ROOT_CAUSE_PRIORITY);
    expect(guess('py', 'python', '-m', 'mypy', '.')).toBe(ROOT_CAUSE_PRIORITY);
    expect(guess('rs', 'cargo', 'check')).toBe(ROOT_CAUSE_PRIORITY);
    expect(guess('style', 'npx', 'eslint', '.')).toBe(LINT_PRIORITY);
    expect(guess('tests', 'npm', 'test')).toBe(SYMPTOM_PRIORITY);
    // Whole words: vitest is not tsc, and rebuild-cache is not build.
    expect(guess('unit', 'npx', 'vitest', 'run')).toBe(SYMPTOM_PRIORITY);
    expect(guess('cache', 'node', 'rebuild-cache.js')).toBe(SYMPTOM_PRIORITY);
  });

  it('takes an explicit priority over the guess, and refuses a non-number', async () => {
    const config = await configWith({
      checks: [
        { id: 'tests', command: 'npm', args: ['test'], editable: ['src/**'], priority: 1 },
        { id: 'types', command: 'npx', args: ['tsc'], editable: ['src/**'] },
      ],
    });
    expect(config.checks.map((c) => c.priority)).toEqual([1, ROOT_CAUSE_PRIORITY]);
    await expect(
      configWith({ checks: [{ id: 't', command: 'x', editable: ['src/**'], priority: 'first' }] }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
