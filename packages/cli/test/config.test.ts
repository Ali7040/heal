import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { matches } from '@self-heal/core/safety/allowlist';

import { ConfigError, DEFAULT_PROTECTED, loadConfig } from '../src/config.js';

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
});
