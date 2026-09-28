import { describe, expect, it } from 'vitest';

import { canTransition, isTerminal, TRANSITIONS, type RunState } from '../src/runner/state.js';

describe('state machine', () => {
  it('reaches HEALED only from VERIFYING (invariant 2)', () => {
    const sources = (Object.keys(TRANSITIONS) as RunState[]).filter((from) =>
      TRANSITIONS[from].includes('HEALED'),
    );
    expect(sources).toEqual(['VERIFYING']);
  });

  it('reaches RESOLVED only from TRIAGING, before any patch of its own exists', () => {
    const sources = (Object.keys(TRANSITIONS) as RunState[]).filter((from) =>
      TRANSITIONS[from].includes('RESOLVED'),
    );
    expect(sources).toEqual(['TRIAGING']);
    expect(isTerminal('RESOLVED')).toBe(true);
  });

  it('never mutates without passing through CHECKPOINTING (invariant 1)', () => {
    // The only edge into PROPOSING — the step that produces a patch — is from
    // CHECKPOINTING, so no proposal can exist without a checkpoint behind it.
    const sources = (Object.keys(TRANSITIONS) as RunState[]).filter((from) =>
      TRANSITIONS[from].includes('PROPOSING'),
    );
    expect(sources).toEqual(['CHECKPOINTING']);
  });

  it('lets a failed proposal escalate instead of throwing', () => {
    expect(canTransition('PROPOSING', 'ESCALATED')).toBe(true);
    expect(canTransition('REVERTED', 'ESCALATED')).toBe(true);
  });

  it('has no outgoing edges from terminal states', () => {
    for (const state of Object.keys(TRANSITIONS) as RunState[]) {
      if (isTerminal(state)) expect(TRANSITIONS[state], state).toEqual([]);
    }
  });

  it('lets REVERTED retry, but only into diagnosis or escalation', () => {
    // REVERTED is an outcome, not a stop. The attempt cap — not the graph —
    // decides which of the two edges is taken (invariant 3).
    expect(isTerminal('REVERTED')).toBe(false);
    expect(TRANSITIONS.REVERTED).toEqual(['DIAGNOSING', 'ESCALATED']);
  });

  it('rejects illegal shortcuts', () => {
    expect(canTransition('DETECTING', 'APPLYING')).toBe(false);
    expect(canTransition('APPLYING', 'HEALED')).toBe(false);
  });
});
