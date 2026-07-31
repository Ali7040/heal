/**
 * Copy a directory into a `FileMap`, so a sandbox can be built from a live repo.
 *
 * This is how a fixer gets a workspace: the files the model may need to read are
 * snapshotted into a disposable repository, the model works there, and the real
 * repository is never exposed to it. Keeping the snapshot explicit — rather than
 * handing the harness a path to the real tree — is what makes the containment
 * claim in the phase-0 write-up true rather than aspirational.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { FileMap } from './sandbox.js';

export interface SnapshotOptions {
  /** Directory names skipped entirely. */
  readonly skipDirs?: readonly string[];
  /** Skip files larger than this — a model has no use for a 5 MB blob. */
  readonly maxFileBytes?: number;
}

const DEFAULT_SKIP = ['.git', 'node_modules', 'dist', '.self-heal'];

export async function snapshotDir(root: string, options: SnapshotOptions = {}): Promise<FileMap> {
  const skip = new Set(options.skipDirs ?? DEFAULT_SKIP);
  const maxBytes = options.maxFileBytes ?? 512 * 1024;
  const files: Record<string, string> = {};

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;

      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      const info = await stat(absolute);
      if (info.size > maxBytes) continue;

      // POSIX separators: the FileMap is repo-relative and platform-neutral.
      const key = relative(root, absolute).split(sep).join('/');
      files[key] = await readFile(absolute, 'utf8');
    }
  }

  await walk(root);
  return files;
}
