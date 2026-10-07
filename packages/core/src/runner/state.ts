/**
 * The loop's states and the only legal moves between them (ARCHITECTURE.md §3).
 *
 * Exactly one transition costs money: `DIAGNOSING → CHECKPOINTING → PROPOSING`.
 * Everything else is free, which is why detection is allowed to run on every commit.
 *
 * The runner implementation lands in phase 1; these types are the contract it must
 * satisfy, and the table below is what its tests assert against.
 */
export type RunState =
  | 'IDLE'
  | 'DETECTING'
  | 'TRIAGING'
  | 'REPLAY'
  | 'DIAGNOSING'
  | 'CHECKPOINTING'
  | 'PROPOSING'
  | 'APPLYING'
  | 'VERIFYING'
  | 'HEALED'
  /** Measured healthy by its own detector before any patch of its own — an earlier fix cured it. */
  | 'RESOLVED'
  /** Failed once, then passed with nothing changed. Not something a patch can fix. */
  | 'FLAKY'
  | 'REVERTED'
  | 'ESCALATED';

/**
 * Recorded outcomes of an attempt. `REVERTED` is an outcome but *not* terminal —
 * it re-enters the loop when the attempt cap allows, which is exactly why the two
 * ideas are separate constants rather than one list.
 */
export const OUTCOME_STATES = ['HEALED', 'RESOLVED', 'FLAKY', 'REVERTED', 'ESCALATED'] as const;
export type OutcomeState = (typeof OUTCOME_STATES)[number];

/** States the loop can stop in. */
export const TERMINAL_STATES = ['HEALED', 'RESOLVED', 'FLAKY', 'ESCALATED'] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

export const TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  IDLE: ['DETECTING'],
  DETECTING: ['TRIAGING', 'IDLE'],
  // Known signature with a verified patch replays without a model call.
  // Or, once a fix has landed this run, an issue its detector now measures
  // healthy is RESOLVED for free — nothing of its own was applied (D-022).
  // Before anything landed, a failure that does not reproduce is FLAKY (D-030).
  TRIAGING: ['REPLAY', 'DIAGNOSING', 'RESOLVED', 'FLAKY'],
  REPLAY: ['APPLYING', 'DIAGNOSING'],
  DIAGNOSING: ['CHECKPOINTING'],
  // Invariant 1: a checkpoint always precedes mutation. No edge skips it.
  CHECKPOINTING: ['PROPOSING'],
  PROPOSING: ['APPLYING', 'ESCALATED'],
  APPLYING: ['VERIFYING', 'REVERTED'],
  // Invariant 2: HEALED is reachable only from VERIFYING.
  VERIFYING: ['HEALED', 'REVERTED'],
  // Retry re-enters the loop at diagnosis; the cap decides whether it may.
  REVERTED: ['DIAGNOSING', 'ESCALATED'],
  HEALED: [],
  RESOLVED: [],
  FLAKY: [],
  ESCALATED: [],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: RunState): state is TerminalState {
  return (TERMINAL_STATES as readonly RunState[]).includes(state);
}
