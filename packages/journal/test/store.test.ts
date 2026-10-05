import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Patch } from '@self-heal/core/contracts/patch';
import { afterEach, describe, expect, it } from 'vitest';

import { openJournal, type CallRecord, type Journal } from '../src/store.js';
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

/**
 * Reading the journal back is what makes a surprising replay explainable. These
 * assertions are about what a person sees, not about SQL.
 */
describe('inspecting a journal', () => {
  it('lists most-recently-seen first, without the patch bodies', async () => {
    // Both records land in the same millisecond on a fast machine, so this also
    // pins the tie-break. Without one, the order is whatever SQLite feels like.
    const { journal } = await journalIn();
    await journal.record({ signature: 'aaa1', kind: 'check-failed', patch: patch('a'), verified: true, attempts: 1, replayed: false });
    await journal.record({ signature: 'bbb2', kind: 'schema-mismatch', patch: patch('b'), verified: false, attempts: 2, replayed: false });

    const entries = journal.list();
    expect(entries.map((entry) => entry.signature)).toEqual(['bbb2', 'aaa1']);
    expect(entries[0]?.files).toEqual(['src/pricing.mjs']);
    // Whole file contents in a terminal answer a different question badly.
    expect(JSON.stringify(entries)).not.toContain('fixed');
  });

  it('honours a limit', async () => {
    const { journal } = await journalIn();
    for (const signature of ['a', 'b', 'c']) {
      await journal.record({ signature, kind: 'check-failed', patch: patch('x'), verified: true, attempts: 1, replayed: false });
    }
    expect(journal.list(2)).toHaveLength(2);
  });

  it('forgets an outcome by its full signature', async () => {
    const { journal } = await journalIn();
    await journal.record({ signature: 'abcdef123456', kind: 'check-failed', patch: patch('a'), verified: true, attempts: 1, replayed: false });

    expect(journal.forget('abcdef123456')).toEqual({ status: 'forgotten', signature: 'abcdef123456' });
    expect(await journal.lookup('abcdef123456')).toBeUndefined();
  });

  it('forgets by the short signature every other surface prints', async () => {
    const { journal } = await journalIn();
    await journal.record({ signature: 'abcdef123456', kind: 'check-failed', patch: patch('a'), verified: true, attempts: 1, replayed: false });

    // The run report and the listing both show eight characters. Printing a
    // short id and demanding the long one is a cruelty that shows up the first
    // time anyone tries it.
    expect(journal.forget('abcdef12')).toEqual({ status: 'forgotten', signature: 'abcdef123456' });
  });

  it('refuses an ambiguous prefix rather than deleting the wrong fix', async () => {
    const { journal } = await journalIn();
    for (const signature of ['abc111', 'abc222']) {
      await journal.record({ signature, kind: 'check-failed', patch: patch('a'), verified: true, attempts: 1, replayed: false });
    }

    // Deleting the wrong remembered fix is silent: the next run just pays for a
    // proposal nobody expected.
    expect(journal.forget('abc')).toEqual({ status: 'ambiguous', matches: ['abc111', 'abc222'] });
    expect(journal.stats().total).toBe(2);
  });

  it('says so when nothing matches', async () => {
    const { journal } = await journalIn();
    expect(journal.forget('nothing')).toEqual({ status: 'not-found' });
  });
});

/**
 * Spend is reported with the benchmark's rules (D-026, D-029): every call counts,
 * failed ones included; cost is per heal; an unknown cost is never zero.
 */
describe('spend', () => {
  const call = (overrides: Partial<CallRecord> = {}): CallRecord => ({
    signature: 'sig-1',
    ok: true,
    failure: null,
    durationMs: 1000,
    costUsd: 0.02,
    promptBytes: 500,
    ...overrides,
  });

  const measure = (journal: Journal, verified: boolean, replayed: boolean) =>
    journal.record({ signature: 'sig-1', kind: 'check-failed', patch: patch('x'), verified, attempts: 1, replayed });

  it('starts empty', async () => {
    const { journal } = await journalIn();
    expect(journal.spend()).toMatchObject({ calls: 0, heals: 0, knownCostUsd: 0, costPerHealUsd: null });
  });

  it('charges every call — failed ones too — against the heals they bought', async () => {
    const { journal } = await journalIn();
    journal.recordCall(call({ costUsd: 0.03 }));
    journal.recordCall(call({ ok: false, failure: 'run-failed', costUsd: 0.01 }));
    journal.recordCall(call({ costUsd: 0.02 }));
    await measure(journal, false, false); // first proposal measured wrong
    await measure(journal, true, false); // second healed it

    const spend = journal.spend();

    expect(spend).toMatchObject({ calls: 3, failedCalls: 1, heals: 1, failedMeasurements: 1, promptBytes: 1500 });
    expect(spend.knownCostUsd).toBeCloseTo(0.06);
    // $0.06 bought one heal.
    expect(spend.costPerHealUsd).toBeCloseTo(0.06);
  });

  it('estimates replay savings from the cost per heal, and counts replays apart from heals', async () => {
    const { journal } = await journalIn();
    journal.recordCall(call({ costUsd: 0.05 }));
    await measure(journal, true, false);
    await measure(journal, true, true);
    await measure(journal, true, true);

    const spend = journal.spend();

    expect(spend).toMatchObject({ heals: 1, replays: 2 });
    expect(spend.estimatedSavedUsd).toBeCloseTo(0.1);
  });

  it('never turns an unknown cost into zero', async () => {
    const { journal } = await journalIn();
    journal.recordCall(call({ costUsd: 0.05 }));
    journal.recordCall(call({ costUsd: null }));
    await measure(journal, true, false);

    const spend = journal.spend();

    expect(spend.unknownCostCalls).toBe(1);
    expect(spend.knownCostUsd).toBeCloseTo(0.05);
    expect(spend.costPerHealUsd).toBeNull();
    expect(spend.estimatedSavedUsd).toBeNull();
  });

  it('counts only what happened since a given moment', async () => {
    const { journal } = await journalIn();
    journal.recordCall(call());
    const later = new Date(Date.now() + 60_000).toISOString();

    expect(journal.spend({ since: later })).toMatchObject({ calls: 0, since: later });
    expect(journal.spend().calls).toBe(1);
  });

  it('upgrades a version-1 journal in place, keeping every remembered fix', async () => {
    // A file exactly as the previous release left it: one table, version 1.
    const dir = await mkdtemp(join(tmpdir(), 'self-heal-journal-'));
    dirs.push(dir);
    const path = join(dir, 'v1.sqlite');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE outcomes (signature TEXT PRIMARY KEY, kind TEXT NOT NULL, patch TEXT NOT NULL,
        verified INTEGER NOT NULL, attempts INTEGER NOT NULL, first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL, replays INTEGER NOT NULL DEFAULT 0);
      PRAGMA user_version = 1;
    `);
    db.prepare('INSERT INTO outcomes VALUES (?, ?, ?, 1, 1, ?, ?, 3)').run(
      'sig-old', 'check-failed', JSON.stringify(patch('kept')), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
    );
    db.close();

    const journal = await openJournal(path);
    open.push(journal);

    expect((await journal.lookup('sig-old'))?.patch.edits[0]?.contents).toBe('kept');
    expect(journal.stats()).toEqual({ total: 1, verified: 1, replays: 3 });
    journal.recordCall(call());
    expect(journal.spend().calls).toBe(1);
  });
});
