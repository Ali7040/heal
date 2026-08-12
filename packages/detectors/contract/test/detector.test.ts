import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunContext } from '@self-heal/core/contracts/context';
import { silentLogger } from '@self-heal/core/logger';
import { getFixture } from '@self-heal/testkit/fixtures';
import { Sandbox } from '@self-heal/testkit/sandbox';
import { freePort, startJsonServer } from '@self-heal/testkit/server';
import { afterEach, describe, expect, it } from 'vitest';

import { ContractDetector, MissingBaselineError } from '../src/index.js';
import { describeShape } from '../src/shape.js';
import { writeBaseline } from '../src/baseline.js';

const HEALTHY = { orders: [{ id: 1, customer: 'ada', total: 1299, currency: 'usd' }] };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  // Reverse order: servers before the directories they were serving from.
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

async function workspace(): Promise<{ root: string; ctx: RunContext }> {
  const root = await mkdtemp(join(tmpdir(), 'self-heal-contract-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    ctx: {
      repoRoot: root,
      evidenceDir: join(root, '.self-heal/evidence'),
      dryRun: false,
      config: {},
      log: silentLogger,
    },
  };
}

async function serve(body: unknown) {
  const server = await startJsonServer(body);
  cleanups.push(() => server.close());
  return server;
}

describe('ContractDetector', () => {
  it('says nothing when the response still matches the recorded contract', async () => {
    const { root, ctx } = await workspace();
    const server = await serve(HEALTHY);
    await writeBaseline(join(root, '.self-heal/contracts'), {
      endpoint: 'orders',
      status: 200,
      shape: describeShape(HEALTHY),
      recordedAt: '2026-01-01T00:00:00.000Z',
    });

    const detector = new ContractDetector({ endpoints: [{ name: 'orders', url: `${server.url}/api/orders` }] });
    expect(await detector.detect(ctx)).toEqual([]);
  });

  it('detects a field the API stopped returning', async () => {
    const { root, ctx } = await workspace();
    await writeBaseline(join(root, '.self-heal/contracts'), {
      endpoint: 'orders',
      status: 200,
      shape: describeShape(HEALTHY),
      recordedAt: '2026-01-01T00:00:00.000Z',
    });
    const server = await serve({ orders: [{ id: 1, customer: 'ada', currency: 'usd' }] });

    const detector = new ContractDetector({
      endpoints: [{ name: 'orders', url: `${server.url}/api/orders`, editable: ['api.mjs'] }],
    });
    const [issue] = await detector.detect(ctx);

    expect(issue?.kind).toBe('schema-mismatch');
    expect(issue?.location).toEqual({ endpoint: 'orders', file: 'api.mjs' });
    expect((issue?.actual as { drifts: unknown[] }).drifts).toEqual([
      { kind: 'field-missing', path: '$.orders[].total', expected: 'number', actual: 'absent' },
    ]);
  });

  it('gives the same regression the same signature on every run', async () => {
    const { root, ctx } = await workspace();
    await writeBaseline(join(root, '.self-heal/contracts'), {
      endpoint: 'orders',
      status: 200,
      shape: describeShape(HEALTHY),
      recordedAt: '2026-01-01T00:00:00.000Z',
    });
    // Different ids, different customer, different row count — same defect.
    const server = await serve({ orders: [{ id: 7, customer: 'grace', currency: 'usd' }] });
    const detector = new ContractDetector({ endpoints: [{ name: 'orders', url: `${server.url}/api/orders` }] });

    const first = (await detector.detect(ctx))[0];
    server.set({ orders: [{ id: 91, customer: 'katherine', currency: 'eur' }, { id: 92, customer: 'x', currency: 'eur' }] });
    const second = (await detector.detect(ctx))[0];

    // Without this the journal never hits, the attempt cap never engages, and the
    // circuit breaker never trips — every run looks like a brand-new problem.
    expect(second?.signature).toBe(first?.signature);
  });

  it('reports a changed status alongside the shape drift, not instead of it', async () => {
    const { root, ctx } = await workspace();
    await writeBaseline(join(root, '.self-heal/contracts'), {
      endpoint: 'orders',
      status: 200,
      shape: describeShape(HEALTHY),
      recordedAt: '2026-01-01T00:00:00.000Z',
    });
    const server = await serve(HEALTHY);
    server.set({ error: 'boom' }, 500);

    const detector = new ContractDetector({ endpoints: [{ name: 'orders', url: `${server.url}/api/orders` }] });
    const [issue] = await detector.detect(ctx);
    const drifts = (issue?.actual as { drifts: { kind: string }[] }).drifts;

    expect(drifts[0]).toEqual({ kind: 'status-changed', path: '$', expected: '200', actual: '500' });
    expect(drifts.some((drift) => drift.kind === 'field-missing')).toBe(true);
  });

  it('records a baseline the first time it sees an endpoint, and reports nothing', async () => {
    const { root, ctx } = await workspace();
    const server = await serve(HEALTHY);

    const detector = new ContractDetector({ endpoints: [{ name: 'orders', url: `${server.url}/api/orders` }] });
    // Nothing to compare against yet. Reporting an issue here would mean the
    // first run of a new endpoint always looks broken.
    expect(await detector.detect(ctx)).toEqual([]);

    const recorded = JSON.parse(await readFile(join(root, '.self-heal/contracts/orders.json'), 'utf8'));
    expect(recorded.shape['$.orders[].total']).toEqual({ type: 'number' });
  });

  it('refuses to record silently when configured not to', async () => {
    const { ctx } = await workspace();
    const server = await serve(HEALTHY);
    const detector = new ContractDetector({
      endpoints: [{ name: 'orders', url: `${server.url}/api/orders` }],
      record: 'never',
    });

    // In CI, a missing contract is a misconfiguration. Recording one on the fly
    // would turn a broken setup into a green run.
    await expect(detector.detect(ctx)).rejects.toBeInstanceOf(MissingBaselineError);
  });

  it('treats an unreachable endpoint as a measurement, not a crash', async () => {
    const { root, ctx } = await workspace();
    await writeBaseline(join(root, '.self-heal/contracts'), {
      endpoint: 'orders',
      status: 200,
      shape: describeShape(HEALTHY),
      recordedAt: '2026-01-01T00:00:00.000Z',
    });
    const port = await freePort();

    const detector = new ContractDetector({
      endpoints: [{ name: 'orders', url: `http://127.0.0.1:${port}/api/orders` }],
      timeoutMs: 2000,
    });
    const [issue] = await detector.detect(ctx);

    expect((issue?.actual as { drifts: { kind: string }[] }).drifts[0]?.kind).toBe('unreachable');
  });

  it('writes the response body to disk and keeps it out of the issue', async () => {
    const { root, ctx } = await workspace();
    await writeBaseline(join(root, '.self-heal/contracts'), {
      endpoint: 'orders',
      status: 200,
      shape: describeShape(HEALTHY),
      recordedAt: '2026-01-01T00:00:00.000Z',
    });
    const server = await serve({ orders: [{ id: 1, customer: 'katherine', currency: 'usd' }] });

    const detector = new ContractDetector({ endpoints: [{ name: 'orders', url: `${server.url}/api/orders` }] });
    const [issue] = await detector.detect(ctx);

    expect(issue?.evidence).toEqual([
      { kind: 'response-body', path: 'contract/orders.json', mediaType: 'application/json' },
    ]);
    const body = await readFile(join(ctx.evidenceDir, 'contract/orders.json'), 'utf8');
    expect(body).toContain('katherine');
    // Evidence is referenced by path, never inlined — an `Issue` gets hashed,
    // logged, journalled, and eventually summarised into a prompt.
    expect(JSON.stringify(issue)).not.toContain('katherine');
  });

  it('cannot be talked into verifying an issue whose contract was deleted', async () => {
    const { root, ctx } = await workspace();
    const dir = join(root, '.self-heal/contracts');
    await writeBaseline(dir, {
      endpoint: 'orders',
      status: 200,
      shape: describeShape(HEALTHY),
      recordedAt: '2026-01-01T00:00:00.000Z',
    });
    const server = await serve({ orders: [{ id: 1, customer: 'ada', currency: 'usd' }] });
    const detector = new ContractDetector({ endpoints: [{ name: 'orders', url: `${server.url}/api/orders` }] });
    const [issue] = await detector.detect(ctx);

    await rm(join(dir, 'orders.json'));
    // Otherwise deleting the contract file would be a way to "fix" any issue.
    expect(await detector.verify(issue!, ctx)).toBe(false);
  });
});

/**
 * The restart test — the reason `withServer` exists.
 *
 * A server started once and probed twice reports the code it booted with, so a
 * fix on disk would verify against the old build and `HEALED` would mean nothing.
 * These cases run a real `node api.mjs` out of the fixture.
 */
describe('ContractDetector against a real server process', () => {
  it('detects the dropped field, and reports healed only once the code changes', async () => {
    const fixture = getFixture('orders-total-dropped');
    const sandbox = await Sandbox.create({ files: fixture.files, prefix: 'self-heal-contract-e2e-' });
    cleanups.push(() => sandbox.dispose());

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const detector = new ContractDetector({
      id: 'orders-api',
      endpoints: [{ name: 'GET /api/orders', url: `${base}/api/orders`, editable: ['api.mjs'] }],
      server: {
        command: process.execPath,
        args: [fixture.serve!.entry],
        readyUrl: `${base}${fixture.serve!.readyPath}`,
        env: { PORT: String(port) },
      },
    });

    const ctx: RunContext = {
      repoRoot: sandbox.dir,
      evidenceDir: join(sandbox.dir, '.self-heal/evidence'),
      dryRun: false,
      config: {},
      log: silentLogger,
    };

    const [issue] = await detector.detect(ctx);
    expect((issue?.actual as { drifts: { path: string }[] }).drifts[0]?.path).toBe('$.orders[].total');

    // Nothing has changed on disk, so the answer must still be no.
    expect(await detector.verify(issue!, ctx)).toBe(false);

    const broken = await sandbox.read('api.mjs');
    const fixed = broken.replaceAll('{ id, customer, currency }', '{ id, customer, total, currency }');
    // Guard against a fixture edit quietly turning this into a test of nothing.
    expect(fixed).not.toBe(broken);
    await sandbox.write('api.mjs', fixed);

    // The fix is only visible because `verify` boots a fresh process. A detector
    // holding one long-lived server would still be answering from the old code.
    expect(await detector.verify(issue!, ctx)).toBe(true);
  });

  it('surfaces a server that will not start instead of hanging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'self-heal-contract-boot-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, '.self-heal/contracts'), { recursive: true });
    await writeFile(join(root, 'api.mjs'), 'throw new Error("syntax is fine, startup is not");\n', 'utf8');

    const port = await freePort();
    const detector = new ContractDetector({
      endpoints: [{ name: 'orders', url: `http://127.0.0.1:${port}/api/orders` }],
      server: {
        command: process.execPath,
        args: ['api.mjs'],
        readyUrl: `http://127.0.0.1:${port}/api/orders`,
        readyTimeoutMs: 1500,
        env: { PORT: String(port) },
      },
    });

    const ctx: RunContext = {
      repoRoot: root,
      evidenceDir: join(root, '.self-heal/evidence'),
      dryRun: false,
      config: {},
      log: silentLogger,
    };

    // The server's own stderr is the only thing that tells a port clash apart
    // from a fixer having just broken the file it edited.
    await expect(detector.detect(ctx)).rejects.toThrow(/startup is not/);
  });
});
