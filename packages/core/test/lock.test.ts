/**
 * The lock is about files on disk racing each other, so it is tested against a
 * real directory. Liveness and time are injected; nothing here sleeps.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireLock, DEFAULT_LOCK_STALE_MS } from '../src/safety/lock.js';

let dir: string | undefined;

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function lockPath(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'self-heal-lock-'));
  return join(dir, 'self-heal.lock');
}

async function plant(path: string, owner: { pid: number; host: string; startedAt: string; token?: string }): Promise<void> {
  await writeFile(path, JSON.stringify({ token: 'other', ...owner }));
}

describe('acquireLock', () => {
  it('lets one holder in, names it to the next, and lets the next in after release', async () => {
    const path = await lockPath();

    const first = await acquireLock(path);
    const second = await acquireLock(path);

    expect(first.acquired).toBe(true);
    expect(second).toMatchObject({ acquired: false, holder: { pid: process.pid, host: hostname() } });

    if (first.acquired) await first.release();
    const third = await acquireLock(path);
    expect(third.acquired).toBe(true);
    if (third.acquired) await third.release();
  });

  it('reclaims a lock whose process on this host is gone', async () => {
    const path = await lockPath();
    await plant(path, { pid: 999_999, host: hostname(), startedAt: new Date().toISOString() });

    const result = await acquireLock(path, { isAlive: () => false });

    expect(result.acquired).toBe(true);
  });

  it('respects a lock whose process on this host is still running', async () => {
    const path = await lockPath();
    await plant(path, { pid: 4242, host: hostname(), startedAt: new Date().toISOString() });

    const result = await acquireLock(path, { isAlive: () => true });

    expect(result).toMatchObject({ acquired: false, holder: { pid: 4242 } });
  });

  it("cannot check another host's process, so waits for age to prove a lock abandoned", async () => {
    const path = await lockPath();
    const started = Date.parse('2026-10-17T00:00:00.000Z');
    await plant(path, { pid: 1, host: 'some-other-machine', startedAt: new Date(started).toISOString() });

    const fresh = await acquireLock(path, { now: () => started + 60_000 });
    const old = await acquireLock(path, { now: () => started + DEFAULT_LOCK_STALE_MS + 1 });

    expect(fresh.acquired).toBe(false);
    expect(old.acquired).toBe(true);
  });

  it('treats an unreadable lock file as stale rather than blocking forever', async () => {
    const path = await lockPath();
    await writeFile(path, 'not json');

    expect((await acquireLock(path)).acquired).toBe(true);
  });

  it('never removes a lock it no longer owns', async () => {
    const path = await lockPath();
    const mine = await acquireLock(path);
    // Reclaimed and re-taken by another run while this one was presumed dead.
    await plant(path, { pid: 7, host: hostname(), startedAt: new Date().toISOString(), token: 'theirs' });

    if (mine.acquired) await mine.release();

    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ token: 'theirs' });
  });
});
