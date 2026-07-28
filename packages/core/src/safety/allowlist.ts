import { isAbsolute, normalize, relative, sep } from 'node:path';

import type { Patch } from '../contracts/patch.js';

/**
 * Invariant 4: patches touching files outside the configured globs are rejected
 * *before* they are applied, not after.
 *
 * Deliberately dependency-free — `core` does not take a glob library to solve a
 * convenience problem. The supported syntax is `*` (one segment) and `**` (any).
 */

export interface AllowlistRejection {
  readonly path: string;
  readonly reason: 'outside-repo' | 'not-allowed';
}

export interface AllowlistResult {
  readonly ok: boolean;
  readonly rejected: readonly AllowlistRejection[];
}

export function checkPatch(patch: Patch, allowed: readonly string[]): AllowlistResult {
  const rejected: AllowlistRejection[] = [];

  for (const edit of patch.edits) {
    if (isAbsolute(edit.path) || escapesRepo(edit.path)) {
      rejected.push({ path: edit.path, reason: 'outside-repo' });
      continue;
    }
    if (!allowed.some((pattern) => matches(toPosix(edit.path), pattern))) {
      rejected.push({ path: edit.path, reason: 'not-allowed' });
    }
  }

  return { ok: rejected.length === 0, rejected };
}

/** `..` traversal, resolved textually so no filesystem access is needed. */
function escapesRepo(path: string): boolean {
  const normalized = normalize(path);
  return normalized === '..' || normalized.startsWith(`..${sep}`) || relative('.', normalized).startsWith('..');
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

export function matches(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path);
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` may match zero segments, so `src/**/*.ts` also matches `src/a.ts`.
        if (pattern[i + 2] === '/') {
          source += '(?:[^/]*/)*';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}
