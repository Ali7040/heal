import { describe, expect, it } from 'vitest';

import type { Patch } from '../src/contracts/patch.js';
import { checkPatch, matches } from '../src/safety/allowlist.js';

function patchTouching(...paths: string[]): Patch {
  return {
    fixerId: 'noop',
    signature: 'sig',
    edits: paths.map((path) => ({ path, contents: '' })),
    rationale: 'test',
  };
}

describe('glob matching', () => {
  it('matches a single segment with *', () => {
    expect(matches('src/a.ts', 'src/*.ts')).toBe(true);
    expect(matches('src/nested/a.ts', 'src/*.ts')).toBe(false);
  });

  it('matches zero or more segments with **', () => {
    expect(matches('src/a.ts', 'src/**/*.ts')).toBe(true);
    expect(matches('src/deep/nested/a.ts', 'src/**/*.ts')).toBe(true);
    expect(matches('other/a.ts', 'src/**/*.ts')).toBe(false);
  });

  it('does not treat glob text as regex', () => {
    expect(matches('srcXa.ts', 'src.a.ts')).toBe(false);
  });
});

describe('checkPatch', () => {
  it('accepts edits inside the allowlist', () => {
    expect(checkPatch(patchTouching('src/api/users.ts'), ['src/**/*.ts']).ok).toBe(true);
  });

  it('rejects edits outside the allowlist', () => {
    const result = checkPatch(patchTouching('scripts/deploy.sh'), ['src/**/*.ts']);
    expect(result.ok).toBe(false);
    expect(result.rejected[0]).toEqual({ path: 'scripts/deploy.sh', reason: 'not-allowed' });
  });

  it('rejects traversal and absolute paths regardless of the allowlist', () => {
    for (const path of ['../outside.ts', '/etc/passwd']) {
      const result = checkPatch(patchTouching(path), ['**']);
      expect(result.ok, path).toBe(false);
      expect(result.rejected[0]?.reason).toBe('outside-repo');
    }
  });

  it('reports every offending path, not just the first', () => {
    const result = checkPatch(patchTouching('a.txt', 'src/ok.ts', 'b.txt'), ['src/**/*.ts']);
    expect(result.rejected.map((r) => r.path)).toEqual(['a.txt', 'b.txt']);
  });
});
