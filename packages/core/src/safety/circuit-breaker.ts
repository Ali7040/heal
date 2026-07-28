/**
 * Invariants 3 and 6.
 *
 * A broken detector should not spend a budget or thrash a repo, so consecutive
 * failed heals trip a breaker that halts the whole run — and no single issue
 * signature is ever attempted a third time.
 */

export const DEFAULT_ATTEMPT_CAP = 2;
export const DEFAULT_FAILURE_THRESHOLD = 3;

export interface CircuitBreakerOptions {
  /** Attempts allowed per issue signature before `ESCALATED`. */
  readonly attemptCap?: number;
  /** Consecutive failed heals that halt the run. */
  readonly failureThreshold?: number;
}

export class CircuitBreaker {
  readonly attemptCap: number;
  readonly failureThreshold: number;

  #consecutiveFailures = 0;
  readonly #attempts = new Map<string, number>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.attemptCap = options.attemptCap ?? DEFAULT_ATTEMPT_CAP;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  }

  attemptsFor(signature: string): number {
    return this.#attempts.get(signature) ?? 0;
  }

  /** False means the cap is spent — the caller must escalate, not retry. */
  mayAttempt(signature: string): boolean {
    return !this.isTripped && this.attemptsFor(signature) < this.attemptCap;
  }

  recordAttempt(signature: string): void {
    this.#attempts.set(signature, this.attemptsFor(signature) + 1);
  }

  recordSuccess(): void {
    this.#consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.#consecutiveFailures += 1;
  }

  get consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }

  get isTripped(): boolean {
    return this.#consecutiveFailures >= this.failureThreshold;
  }
}
