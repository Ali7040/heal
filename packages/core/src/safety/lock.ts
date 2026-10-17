/**
 * One run per repository at a time (D-035).
 *
 * Two runs against one tree interleave checkpoints and restores: run A restores
 * to its checkpoint and silently discards run B's half-applied patch, or commits
 * it under A's name. Every invariant about "the tree is what we think it is"
 * assumes nobody else is writing to it. Watch mode, a pre-push hook, and a manual
 * run make that a real collision rather than a theoretical one.
 *
 * The lock lives in the git directory, never the working tree: a lock file in the
 * tree would make it dirty and halt the very run that wrote it (invariant 5).
 *
 * Creation is atomic (`wx`), so two runs racing for it cannot both win. A lock
 * whose owner is gone — the process crashed, or was killed — is reclaimed: on the
 * same host when that process no longer exists, or anywhere once it is older than
 * `staleAfterMs`. Release removes the file only if it is still ours.
 */
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';

export interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
  readonly token: string;
}

export type LockResult =
  | { readonly acquired: true; readonly release: () => Promise<void> }
  | { readonly acquired: false; readonly holder: LockOwner | null };

export interface LockOptions {
  /** A lock older than this is assumed abandoned, whatever host it came from. */
  readonly staleAfterMs?: number;
  /** For tests: whether a pid on this host is still running. */
  readonly isAlive?: (pid: number) => boolean;
  readonly now?: () => number;
}

/** Longer than any sane run, short enough that a crash does not block a repo for a day. */
export const DEFAULT_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

export async function acquireLock(path: string, options: LockOptions = {}): Promise<LockResult> {
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? processExists;
  const staleAfter = options.staleAfterMs ?? DEFAULT_LOCK_STALE_MS;

  const owner: LockOwner = { pid: process.pid, host: hostname(), startedAt: new Date(now()).toISOString(), token: randomUUID() };

  // Two tries: the second only after removing a lock proven stale. A lock that
  // reappears in between belongs to a run that won the race fairly.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await create(path, owner)) {
      return { acquired: true, release: () => release(path, owner.token) };
    }

    const holder = await read(path);
    const stale =
      holder === null ||
      now() - Date.parse(holder.startedAt) > staleAfter ||
      (holder.host === owner.host && !isAlive(holder.pid));

    if (!stale || attempt === 1) return { acquired: false, holder };
    await unlink(path).catch(() => {});
  }

  return { acquired: false, holder: await read(path) };
}

async function create(path: string, owner: LockOwner): Promise<boolean> {
  try {
    await writeFile(path, `${JSON.stringify(owner)}\n`, { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** The current holder, or `null` for a file that is unreadable or not a lock — treated as stale. */
async function read(path: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<LockOwner>;
    if (typeof parsed.pid !== 'number' || typeof parsed.host !== 'string' || typeof parsed.startedAt !== 'string') {
      return null;
    }
    return { pid: parsed.pid, host: parsed.host, startedAt: parsed.startedAt, token: String(parsed.token ?? '') };
  } catch {
    return null;
  }
}

async function release(path: string, token: string): Promise<void> {
  // Never delete a lock that was reclaimed and re-taken by someone else.
  const holder = await read(path);
  if (holder?.token === token) await unlink(path).catch(() => {});
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is just not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
