import { describe, expect, it } from 'vitest';

import { CircuitBreaker } from '../src/safety/circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('never allows a third attempt at one signature (default cap 2)', () => {
    const breaker = new CircuitBreaker();

    expect(breaker.mayAttempt('sig')).toBe(true);
    breaker.recordAttempt('sig');
    expect(breaker.mayAttempt('sig')).toBe(true);
    breaker.recordAttempt('sig');
    expect(breaker.mayAttempt('sig')).toBe(false);
  });

  it('tracks signatures independently', () => {
    const breaker = new CircuitBreaker({ attemptCap: 1 });
    breaker.recordAttempt('a');
    expect(breaker.mayAttempt('a')).toBe(false);
    expect(breaker.mayAttempt('b')).toBe(true);
  });

  it('trips after N consecutive failures and halts everything', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    breaker.recordFailure();
    expect(breaker.isTripped).toBe(false);
    breaker.recordFailure();
    expect(breaker.isTripped).toBe(true);
    expect(breaker.mayAttempt('untouched-signature')).toBe(false);
  });

  it('resets the failure streak on a success', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.isTripped).toBe(false);
  });
});
