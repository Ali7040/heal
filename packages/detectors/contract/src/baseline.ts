/**
 * The recorded contract: what this endpoint looked like when someone last said
 * it was correct.
 *
 * These files are meant to be **committed to the repository**, which drives every
 * decision in here. They are sorted, pretty-printed, and free of timestamps in
 * the shape itself, so a drift shows up as a readable line in a pull request
 * rather than as a churning blob. The recorded contract is the closest thing this
 * project has to a human judgement — a person reviewed the diff and merged it —
 * and everything downstream is machinery for noticing when reality stops matching
 * it.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ShapeMap } from './shape.js';

export interface Baseline {
  readonly endpoint: string;
  readonly status: number;
  readonly shape: ShapeMap;
  readonly recordedAt: string;
}

export const DEFAULT_CONTRACTS_DIR = '.self-heal/contracts';

export async function readBaseline(dir: string, endpoint: string): Promise<Baseline | null> {
  try {
    const raw = await readFile(pathFor(dir, endpoint), 'utf8');
    const parsed = JSON.parse(raw) as Baseline;
    // A malformed contract is treated as no contract rather than as a crash:
    // the recovery is identical (record a fresh one) and it keeps a hand-edited
    // file from taking down a run.
    return typeof parsed.status === 'number' && typeof parsed.shape === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeBaseline(dir: string, baseline: Baseline): Promise<string> {
  const target = pathFor(dir, baseline.endpoint);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  return target;
}

/** `GET /api/orders` → `<dir>/get-api-orders.json`. Stable, and safe on every OS. */
export function pathFor(dir: string, endpoint: string): string {
  return join(dir, `${slug(endpoint)}.json`);
}

export function slug(endpoint: string): string {
  return (
    endpoint
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'endpoint'
  );
}
