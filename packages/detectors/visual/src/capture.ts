/**
 * Where the pixels come from.
 *
 * A port, not a browser. The measurement this detector performs is "compare an
 * image against a recorded baseline", and *how* the image is produced is a
 * separate question with several right answers: an endpoint that renders a chart,
 * a thumbnail service, a canvas snapshot, or a real browser screenshot.
 *
 * Keeping that behind an interface is what lets the pixel comparison — the part
 * with the actual judgement in it — be tested without installing a browser, and
 * what lets a project that already has its own screenshot tooling plug it in
 * rather than adopting ours.
 */
import { commandExists, runCommand } from '@self-heal/core/process';
import { probe } from '@self-heal/core/http';

export interface Capture {
  readonly bytes: Uint8Array;
  /** What produced this, for the failure message when it is not an image. */
  readonly source: string;
}

export interface Screenshotter {
  readonly id: string;
  capture(): Promise<Capture>;
}

export class CaptureError extends Error {}

/**
 * The image is whatever the URL returns.
 *
 * Covers chart endpoints, generated thumbnails, PDF page renders, `/preview.png`
 * routes — anywhere the system under test already produces an image. No browser,
 * no dependency, and the request is an ordinary measurement like any other probe.
 */
export class UrlScreenshotter implements Screenshotter {
  readonly id = 'url';
  readonly #url: string;
  readonly #timeoutMs: number;

  constructor(url: string, timeoutMs = 15_000) {
    this.#url = url;
    this.#timeoutMs = timeoutMs;
  }

  async capture(): Promise<Capture> {
    const result = await probe({ url: this.#url, timeoutMs: this.#timeoutMs });
    if (!result.reached) throw new CaptureError(`could not reach ${this.#url}: ${result.error}`);
    if (result.status >= 400) throw new CaptureError(`${this.#url} answered HTTP ${result.status}`);

    // `probe` decodes as text, which would corrupt binary. Ask again for bytes.
    const response = await fetch(this.#url, { signal: AbortSignal.timeout(this.#timeoutMs) });
    return { bytes: new Uint8Array(await response.arrayBuffer()), source: this.#url };
  }
}

/**
 * A real browser, through the Playwright CLI.
 *
 * Deliberately shelled out rather than imported: Playwright is a large optional
 * dependency with a browser download attached, and requiring it to install this
 * package would make a visual detector that most projects cannot run. Here it is a
 * capability that is used when present and reported clearly when absent.
 *
 * Not covered by the test suite — a test that needs a browser binary is exactly
 * the kind AGENTS.md says belongs behind an integration script.
 */
export class PlaywrightScreenshotter implements Screenshotter {
  readonly id = 'playwright';
  readonly #url: string;
  readonly #options: { viewport?: string; fullPage?: boolean; waitMs?: number; timeoutMs?: number };

  constructor(url: string, options: { viewport?: string; fullPage?: boolean; waitMs?: number; timeoutMs?: number } = {}) {
    this.#url = url;
    this.#options = options;
  }

  async capture(): Promise<Capture> {
    if (!(await commandExists('npx'))) {
      throw new CaptureError('playwright capture needs `npx` on PATH');
    }

    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = await mkdtemp(join(tmpdir(), 'self-heal-shot-'));
    const target = join(dir, 'shot.png');

    try {
      const result = await runCommand(
        'npx',
        [
          'playwright',
          'screenshot',
          ...(this.#options.fullPage === true ? ['--full-page'] : []),
          ...(this.#options.viewport !== undefined ? ['--viewport-size', this.#options.viewport] : []),
          ...(this.#options.waitMs !== undefined ? ['--wait-for-timeout', String(this.#options.waitMs)] : []),
          this.#url,
          target,
        ],
        { cwd: process.cwd(), timeoutMs: this.#options.timeoutMs ?? 90_000 },
      );

      if (!result.ok) {
        throw new CaptureError(
          `playwright screenshot failed (exit ${result.code}).\n${`${result.stdout}${result.stderr}`.trim()}`,
        );
      }
      return { bytes: new Uint8Array(await readFile(target)), source: `playwright ${this.#url}` };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** For tests and for a project whose own tooling already produces the image. */
export class StaticScreenshotter implements Screenshotter {
  readonly id = 'static';
  readonly #produce: () => Promise<Uint8Array> | Uint8Array;

  constructor(produce: () => Promise<Uint8Array> | Uint8Array) {
    this.#produce = produce;
  }

  async capture(): Promise<Capture> {
    return { bytes: await this.#produce(), source: 'static' };
  }
}
