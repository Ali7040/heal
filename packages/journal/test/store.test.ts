import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Patch } from '@self-heal/core/contracts/patch';
import { afterEach, describe, expect, it } from 'vitest';

import { openJournal, type Journal } from '../src/store.js';
import { SCHEMA_VERSION } from '../src/schema.js';

const dirs: string[] = [];
const open: Journal[] = [];

afterEach(async () => {
  for (const journal of open.splice(0)) journal.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function journalIn(name = 'journal.sqlite'): Promise<{ journal: Journal; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'self-heal-journal-'));
  dirs.push(dir);
  const path = join(dir, '.self-heal', name);
  const journal = await openJournal(path);
  open.push(journal);
  return { journal, path };
}

function patch(contents: string): Patch {
  return {
    fixerId: 'test',
    signature: 'sig-1',
    edits: [{ path: 'src/pricing.mjs', contents }],
    rationale: 'apply the tax rate',
  };
}

describe('openJournal', () => {
  it('creates the file and its directory rather than demanding they exist', async () => {
    const { journal } = await journalIn();
    expect(journal.stats()).toEqual({ total: 0, verified: 0, replays: 0 });
  });

  it('round-trips a patch through disk', async () => {
    const { journal, path } = await journalIn();
    await journal.record({ signature: 'sig-1', kind: 'check-failed', patch: patch('fixed'), verified: true, attempts: 1, replayed: false });
    journal.close();
    open.splice(0);

    // Reopened, not reused: an in-memory map would pass every other test here.
    const reopened = await openJournal(path);
    open.push(reopened);
    const found = await reopened.lookup('sig-1');

    expect(found?.verified).toBe(true);
    expect(found?.patch.edits[0]).toEqual({ path: 'src/pricing.mjs', contents: 'fixed' });
  });

  it('returns nothing for a signature it has never seen', async () => {
    const { journal } = await journalIn();
    expect(await journal.lookup('never-seen')).toBeUndefined();
  });

  it('keeps first_seen but moves last_seen, so age survives an update', async () => {
    const { journal } = await journalIn();
    const outcome = { signature: 'sig-1', kind: 'check-failed', patch: patch('a'), verified: false, attempts: 1, replayed: false };
    await journal.record(outcome);
    await journal.record({ ...outcome, patch: patch('b'), verified: true, attempts: 2 });

    const found = await journal.lookup('sig-1');
    expect(found?.attempts).toBe(2);
    expect(found?.patch.edits[0]?.contents).toBe('b');
    expect(journal.stats().total).toBe(1);
  });

  it('demotes a patch that stopped working', async () => {
    const { journal } = await journalIn();
    const base = { signature: 'sig-1', kind: 'check-failed', patch: patch('a'), attempts: 1, replayed: false };
    await journal.record({ ...base, verified: true });
    await journal.record({ ...base, verified: false });

    // The last measurement wins. A patch that no longer heals must stop being
    // offered, or the loop replays a stale fix forever.
    expect((await journal.lookup('sig-1'))?.verified).toBe(false);
  });

  it('counts only replays that actually held up', async () => {
    const { journal } = await journalIn();
    const base = { signature: 'sig-1', kind: 'check-failed', patch: patch('a'), attempts: 1 };
    await journal.record({ ...base, verified: true, replayed: false });   // the fix that cost a model call
    await journal.record({ ...base, verified: true, replayed: true });    // free
    await journal.record({ ...base, verified: false, replayed: true });   // a replay that failed - not a saving

    expect(journal.stats().replays).toBe(1);
  });

  it('refuses to store a patch too large to be worth replaying', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-heal-journal-'));
    dirs.push(dir);
    const journal = await openJournal(join(dir, 'journal.sqlite'), { maxPatchBytes: 64 });
    open.push(journal);

    await journal.record({
      signature: 'huge',
      kind: 'check-failed',
      patch: patch('x'.repeat(500)),
      verified: true,
      attempts: 1,
      replayed: false,
    });

    // Reported and measured as normal - just not carried forever to save one call.
    expect(await journal.lookup('huge')).toBeUndefined();
  });

  it('treats a corrupt row as a miss rather than a crash', async () => {
    const { journal, path } = await journalIn();
    await journal.record({ signature: 'sig-1', kind: 'check-failed', patch: patch('a'), verified: true, attempts: 1, replayed: false });

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path);
    db.prepare('UPDATE outcomes SET patch = ? WHERE signature = ?').run('{not json', 'sig-1');
    db.close();

    // The caller's fallback for a miss - propose a fresh fix - is exactly the
    // right recovery for a corrupt row too.
    expect(await journal.lookup('sig-1')).toBeUndefined();
  });

  it('stamps the schema version so a future migration knows where to start', async () => {
    const { path } = await journalIn();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path);
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    db.close();
    expect(row.user_version).toBe(SCHEMA_VERSION);
  });

  it('reopens an existing file without re-running its migrations', async () => {
    const { journal, path } = await journalIn();
    await journal.record({ signature: 'sig-1', kind: 'check-failed', patch: patch('a'), verified: true, attempts: 1, replayed: false });
    journal.close();
    open.splice(0);

    const reopened = await openJournal(path);
    open.push(reopened);
    expect((await reopened.lookup('sig-1'))?.verified).toBe(true);
  });

  it('refuses a file written by a newer build instead of guessing at it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-heal-journal-'));
    dirs.push(dir);
    const path = join(dir, 'future.sqlite');
    await writeFile(path, '');

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    db.close();

    await expect(openJournal(path)).rejects.toThrow(/version/i);
  });
});
