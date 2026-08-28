/**
 * Phase 2: a deliberately broken endpoint is detected.
 *
 * The measurement is: boot the API, request an endpoint, reduce the response to a
 * shape, compare that shape to the one recorded in the repository. No model is
 * reachable from this file, by construction — the imports are HTTP, JSON, and the
 * file system.
 *
 * The reason this detector exists is not that schema drift is the most important
 * bug in the world. It is that it is a *completely different kind of measurement*
 * from `CommandDetector`'s exit code: it needs a running server, a recorded
 * baseline, an evidence artifact, and a notion of partial equality. If the engine
 * absorbs it without changing, the plugin boundary from phase 1 was real. That
 * test is the actual deliverable — and `packages/core` has one addition to show
 * for it (`startProcess`), which is a primitive rather than a concession.
 */
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import type { RunContext } from '@self-heal/core/contracts/context';
import type { Detector } from '@self-heal/core/contracts/detector';
import type { EvidenceRef, Issue, Severity } from '@self-heal/core/contracts/issue';
import { computeSignature } from '@self-heal/core/signature';

import { DEFAULT_CONTRACTS_DIR, readBaseline, slug, writeBaseline, type Baseline } from './baseline.js';
import { diffShapes, type Drift } from './diff.js';
import { probe, type ProbeResult } from '@self-heal/core/http';
import { describeShape } from './shape.js';
import { withServer, type ServerConfig } from '@self-heal/core/server';

export { describeShape, type ShapeMap, type ShapeEntry } from './shape.js';
export { diffShapes, formatDrifts, type Drift, type DriftKind } from './diff.js';
export { probe, waitForReady, type ProbeResult } from '@self-heal/core/http';
export { readBaseline, writeBaseline, pathFor, DEFAULT_CONTRACTS_DIR, type Baseline } from './baseline.js';
export { withServer, ServerStartError, type ServerConfig } from '@self-heal/core/server';

export interface EndpointConfig {
  /** Stable name — the contract filename and the issue's location. */
  readonly name: string;
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Files a fixer may edit when this endpoint drifts. */
  readonly editable?: readonly string[];
}

export interface ContractDetectorOptions {
  readonly id?: string;
  readonly endpoints: readonly EndpointConfig[];
  /** Boots before every measurement and dies after it. Omit if already running. */
  readonly server?: ServerConfig;
  /** Where recorded contracts live, relative to the repo root. */
  readonly contractsDir?: string;
  /** Treat unexpected fields as drift too (D-010). */
  readonly strict?: boolean;
  /**
   * `missing` records a contract the first time an endpoint is seen and reports
   * nothing for it. `never` refuses — for CI, where an absent contract means a
   * misconfiguration and silently recording one would hide it.
   */
  readonly record?: 'missing' | 'never';
  readonly timeoutMs?: number;
  readonly severity?: Severity;
}

export class MissingBaselineError extends Error {}

export class ContractDetector implements Detector {
  readonly id: string;
  readonly #options: ContractDetectorOptions;

  constructor(options: ContractDetectorOptions) {
    this.id = options.id ?? 'contract';
    this.#options = options;
  }

  async detect(ctx: RunContext): Promise<Issue[]> {
    return this.#withServer(ctx, async () => {
      const issues: Issue[] = [];
      for (const endpoint of this.#options.endpoints) {
        const issue = await this.#detectOne(endpoint, ctx);
        if (issue !== null) issues.push(issue);
      }
      return issues;
    });
  }

  /**
   * Re-measure the one endpoint this issue came from.
   *
   * Deliberately narrow: verifying every endpoint would let an unrelated
   * regression elsewhere veto a fix that worked, and would let a fix that broke a
   * neighbouring endpoint still pass. The issue names its endpoint; that endpoint
   * is what gets re-measured, against the same recorded contract as before.
   */
  async verify(issue: Issue, ctx: RunContext): Promise<boolean> {
    const name = issue.location.endpoint;
    const endpoint = this.#options.endpoints.find((candidate) => candidate.name === name);
    if (endpoint === undefined) return false;

    return this.#withServer(ctx, async () => {
      const baseline = await readBaseline(this.#contractsDir(ctx), endpoint.name);
      // No contract means nothing to verify against. Reporting healthy here would
      // let deleting a contract file "fix" an issue.
      if (baseline === null) return false;

      const result = await this.#probe(endpoint);
      return this.#drifts(baseline, result).length === 0;
    });
  }

  async #detectOne(endpoint: EndpointConfig, ctx: RunContext): Promise<Issue | null> {
    const dir = this.#contractsDir(ctx);
    const result = await this.#probe(endpoint);
    const existing = await readBaseline(dir, endpoint.name);

    if (existing === null) {
      if ((this.#options.record ?? 'missing') === 'never') {
        throw new MissingBaselineError(
          `no recorded contract for "${endpoint.name}" in ${dir}.\n` +
            'Run once with record="missing" and commit the file, or fix the endpoint name.',
        );
      }
      // Recording a baseline is not a measurement — there is nothing yet to
      // compare against. Say nothing and let the next run be the first one that
      // can have an opinion.
      await this.#record(dir, endpoint, result, ctx);
      return null;
    }

    const drifts = this.#drifts(existing, result);
    if (drifts.length === 0) return null;

    const location: Issue['location'] = {
      endpoint: endpoint.name,
      ...(endpoint.editable?.[0] !== undefined ? { file: endpoint.editable[0] } : {}),
    };
    const kind = 'schema-mismatch';
    // Only drift-derived facts go into the signature. Response *values* never do:
    // an id that changes every request would give the same regression a new
    // identity on every run, and the journal, the attempt cap, and the circuit
    // breaker all key off that identity.
    const expected = { status: existing.status, contract: slug(endpoint.name) };
    const actual = { status: result.reached ? result.status : null, drifts };

    return {
      signature: computeSignature({ detectorId: this.id, kind, location, expected, actual }),
      detectorId: this.id,
      kind,
      location,
      expected,
      actual,
      evidence: await this.#writeEvidence(endpoint, result, ctx),
      severity: this.#options.severity ?? 'high',
      detectedAt: new Date().toISOString(),
    };
  }

  #drifts(baseline: Baseline, result: ProbeResult): Drift[] {
    if (!result.reached) {
      return [{ kind: 'unreachable', path: '$', expected: `HTTP ${baseline.status}`, actual: result.error }];
    }
    if (!result.isJson) {
      return [
        {
          kind: 'body-not-json',
          path: '$',
          expected: 'JSON body',
          actual: `${result.bodyText.length} bytes of non-JSON`,
        },
      ];
    }

    const drifts: Drift[] = [];
    if (result.status !== baseline.status) {
      // Status drift is reported alongside shape drift rather than instead of it.
      // A 500 whose body is an error object would otherwise look like every field
      // vanishing at once, which is true but useless.
      drifts.push({
        kind: 'status-changed',
        path: '$',
        expected: String(baseline.status),
        actual: String(result.status),
      });
    }

    const options = this.#options.strict === true ? { strict: true } : {};
    return [...drifts, ...diffShapes(baseline.shape, describeShape(result.json), options)];
  }

  async #record(dir: string, endpoint: EndpointConfig, result: ProbeResult, ctx: RunContext): Promise<void> {
    if (!result.reached || !result.isJson) {
      ctx.log.warn(`contract: cannot record "${endpoint.name}" — no JSON response`, {
        endpoint: endpoint.name,
        reason: result.reached ? 'body is not JSON' : result.error,
      });
      return;
    }

    const baseline: Baseline = {
      endpoint: endpoint.name,
      status: result.status,
      shape: describeShape(result.json),
      recordedAt: new Date().toISOString(),
    };
    const path = await writeBaseline(dir, baseline);
    ctx.log.info(`contract: recorded baseline for "${endpoint.name}"`, { path });
  }

  /**
   * The response body is written to disk and referenced by path, never carried
   * inside the issue (ARCHITECTURE §2). A 4 MB JSON response inlined into an
   * `Issue` would be hashed on every signature computation, logged, stored in the
   * journal, and eventually pasted into a prompt.
   */
  async #writeEvidence(endpoint: EndpointConfig, result: ProbeResult, ctx: RunContext): Promise<EvidenceRef[]> {
    if (!result.reached) return [];

    const relative = `contract/${slug(endpoint.name)}.json`;
    const target = join(ctx.evidenceDir, relative);
    try {
      await mkdir(join(ctx.evidenceDir, 'contract'), { recursive: true });
      await writeFile(target, result.bodyText, 'utf8');
    } catch (error) {
      // Evidence is diagnostic, not load-bearing. A read-only or missing
      // evidence directory must not stop the loop from reporting a real issue.
      ctx.log.warn('contract: could not write evidence', { path: target, error: String(error) });
      return [];
    }
    return [{ kind: 'response-body', path: relative, mediaType: 'application/json' }];
  }

  async #probe(endpoint: EndpointConfig): Promise<ProbeResult> {
    return probe({
      url: endpoint.url,
      ...(endpoint.method !== undefined ? { method: endpoint.method } : {}),
      ...(endpoint.headers !== undefined ? { headers: endpoint.headers } : {}),
      ...(endpoint.body !== undefined ? { body: endpoint.body } : {}),
      ...(this.#options.timeoutMs !== undefined ? { timeoutMs: this.#options.timeoutMs } : {}),
    });
  }

  async #withServer<T>(ctx: RunContext, run: () => Promise<T>): Promise<T> {
    const server = this.#options.server;
    if (server === undefined) return run();
    return withServer(server, ctx.repoRoot, run);
  }

  #contractsDir(ctx: RunContext): string {
    return join(ctx.repoRoot, this.#options.contractsDir ?? DEFAULT_CONTRACTS_DIR);
  }
}
