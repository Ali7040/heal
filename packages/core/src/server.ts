/**
 * Booting the thing being measured, for exactly as long as the measurement takes.
 *
 * This is the piece that makes an API contract healable at all. A fixer edits a
 * route handler on disk; a server process started before that edit is still
 * running the old code, so re-probing it would "verify" the previous build and
 * report success for a fix that changed nothing. Any measurement that outlives
 * the process it measures is not a measurement.
 *
 * The fix is to make the boot part of the measurement: start a fresh server, probe
 * it, kill it — on `detect` and again on `verify`. It costs a second or two per
 * cycle and removes an entire category of false `HEALED`.
 *
 * Note where this lives. The runner has no `restartServer` hook and should never
 * grow one: "what has to be true before I can measure this" is knowledge the
 * detector owns. A compiled project would put its build step here for the same
 * reason.
 *
 * It sits in `core` as a primitive, not as a policy: `core` offers "run something
 * while this is alive" the same way it offers `runCommand`, and every decision
 * about *whether* to boot, and what counts as ready, stays with the detector that
 * called it. It moved here the moment a second detector needed it (D-014).
 */
import { startProcess } from './process.js';

import { waitForReady } from './http.js';

export interface ServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  /** Defaults to the repo root. */
  readonly cwd?: string;
  /** Polled until it answers. Without it, probing races the server's startup. */
  readonly readyUrl: string;
  readonly readyTimeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
}

export class ServerStartError extends Error {}

export async function withServer<T>(config: ServerConfig, cwd: string, run: () => Promise<T>): Promise<T> {
  const handle = await startProcess(config.command, config.args ?? [], {
    cwd: config.cwd ?? cwd,
    ...(config.env ? { env: config.env } : {}),
  });

  try {
    const ready = await waitForReady(config.readyUrl, config.readyTimeoutMs ?? 10_000);
    if (!ready) {
      // The server's own output is the only useful thing to say here — a port
      // clash or a syntax error in the file the fixer just edited both surface
      // as "never became ready", and only the output tells them apart.
      throw new ServerStartError(
        `server did not answer ${config.readyUrl} in time.\n${handle.output().trim() || '(no output)'}`,
      );
    }
    return await run();
  } finally {
    // `finally`, not the happy path: a probe that throws must not leak a process
    // holding a port, or every subsequent run fails for an unrelated reason.
    await handle.stop();
  }
}
