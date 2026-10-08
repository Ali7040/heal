/**
 * The disposable repository a harness is allowed to edit.
 *
 * This is the containment boundary, and it is the reason the phase-0 claim —
 * "the model never touches your working tree" — is true rather than aspirational.
 * The harness is handed a path, and that path is a copy in the OS temp directory
 * that stops existing when the proposal is done.
 *
 * Until now the only implementation lived in `testkit`, which meant the one
 * production path that matters could not be used without importing test tooling.
 * This is that implementation, as a shipped thing.
 *
 * **Tracked files only.** The file list comes from `git ls-files`, so the user's
 * `.gitignore` decides what a model can see. That is the right authority to
 * delegate to: it is already the list of "things that belong to this project",
 * it already excludes `node_modules` and build output, and — the part that
 * matters — it already excludes `.env` and whatever else a team has decided does
 * not leave the machine.
 */
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

import { GitRepo } from '@self-heal/core/git/repo';
import { matches } from '@self-heal/core/safety/allowlist';

import type { HarnessWorkspace } from './index.js';

export interface GitWorkspaceOptions {
  readonly repoRoot: string;
  readonly prefix?: string;
  /** Skip files larger than this. A model has no use for a 5 MB blob. */
  readonly maxFileBytes?: number;
  /**
   * Globs never copied in, even when tracked — the secrets a team committed by
   * mistake (`.env`, private keys). What is not in the sandbox, the model cannot
   * read, quote, or send anywhere (D-031).
   */
  readonly exclude?: readonly string[];
}

export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

export class WorkspaceError extends Error {}

export async function createGitWorkspace(options: GitWorkspaceOptions): Promise<HarnessWorkspace> {
  const source = new GitRepo({ dir: options.repoRoot });
  const listed = await source.git('ls-files', '-z');
  if (!listed.ok) {
    throw new WorkspaceError(
      `could not list files in ${options.repoRoot}: ${listed.stderr.trim() || `git exited ${listed.code}`}`,
    );
  }

  const exclude = options.exclude ?? [];
  const paths = listed.stdout
    .split('\0')
    .filter((path) => path !== '' && !exclude.some((glob) => matches(path, glob)));
  if (paths.length === 0) {
    throw new WorkspaceError(`${options.repoRoot} has no tracked files — nothing for a fixer to work from`);
  }

  const dir = await mkdtemp(join(tmpdir(), options.prefix ?? 'self-heal-work-'));
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  try {
    for (const path of paths) {
      const from = join(options.repoRoot, ...path.split('/'));
      // A tracked file can be missing if the tree was modified between listing
      // and copying. Skipping beats failing the whole proposal over one file.
      const info = await stat(from).catch(() => null);
      if (info === null || !info.isFile() || info.size > maxBytes) continue;

      const to = join(dir, ...path.split('/'));
      await mkdir(dirname(to), { recursive: true });
      // Byte-for-byte, not read-as-utf8: a PNG baseline or any other binary in
      // the tree would be silently corrupted by a text round trip.
      await copyFile(from, to);
    }

    const repo = new GitRepo({ dir });
    await repo.init();
    // Without this a `reset --hard` on Windows restores through autocrlf and the
    // bytes differ from what was written — the same trap the sandbox hit in
    // phase 1.
    await repo.git('config', 'core.autocrlf', 'false');

    const baseline = await repo.checkpoint('workspace baseline');
    if (baseline === null) {
      throw new WorkspaceError(`could not commit a baseline in ${dir}`);
    }

    return {
      dir,
      dispose: async () => {
        // Cleanup failure must never fail a run: a leaked temp directory is a
        // nuisance, a throw from a `finally` block hides the real problem.
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Windows-safe comparison for tests and callers that care about layout. */
export function toPosix(path: string): string {
  return path.split(sep).join('/');
}
