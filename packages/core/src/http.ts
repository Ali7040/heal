/**
 * One HTTP request, reduced to a measurement.
 *
 * Every failure mode is a value here, never a throw — the same rule the rest of
 * the loop follows. A connection refused, a timeout, a 500, and a body that is
 * not JSON are four different facts about an endpoint, and the detector needs to
 * tell them apart: "the server is down" and "the server dropped a field" are both
 * problems, but only one of them is something a code fixer can do anything about.
 */

export interface ProbeRequest {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

export type ProbeResult =
  | { readonly reached: true; readonly status: number; readonly bodyText: string; readonly json: unknown; readonly isJson: true }
  | { readonly reached: true; readonly status: number; readonly bodyText: string; readonly isJson: false }
  | { readonly reached: false; readonly error: string };

export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export async function probe(request: ProbeRequest): Promise<ProbeResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method ?? 'GET',
      ...(request.headers ? { headers: { ...request.headers } } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Covers refused connections, DNS failures, and the timeout above. All of
    // them mean the same thing to the loop: nothing was measured.
    return { reached: false, error: describeError(error, timeoutMs) };
  }

  const bodyText = await response.text().catch(() => '');

  try {
    return { reached: true, status: response.status, bodyText, json: JSON.parse(bodyText), isJson: true };
  } catch {
    return { reached: true, status: response.status, bodyText, isJson: false };
  }
}

function describeError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === 'TimeoutError') return `no response within ${timeoutMs}ms`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Wait for a server to start answering.
 *
 * Polling beats a fixed sleep for the same reason the loop measures instead of
 * assuming: a sleep long enough to be reliable on a loaded CI box is a sleep
 * wasted on every fast run, and a shorter one turns into an intermittent failure
 * nobody can reproduce.
 */
export async function waitForReady(url: string, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe({ url, timeoutMs: Math.max(250, intervalMs * 5) });
    if (result.reached) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
