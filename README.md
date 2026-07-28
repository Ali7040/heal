# self-heal

A closed-loop agent that **detects** regressions with deterministic code, **proposes**
a fix through the agent harness you already have installed, **verifies** the fix by
re-running the original detection, and **records** the measured outcome.

> **The deterministic layer never asks the LLM anything.
> The LLM never measures anything.**

`HEALED` means one thing only: the measurement that found the problem now passes.
Never that a model reported success.

---

## Status

Pre-phase-1. The contracts, safety primitives, and state graph are in place and
tested; the runner, detectors, journal, and harness adapter are not implemented yet.

| Phase | Deliverable | State |
|---|---|---|
| 0 | Harness invocation spike | not started |
| 1 | `core` + contracts + `noop` fixer | contracts + safety done; runner pending |
| 2 | Contract detector | stub |
| 3 | Real fixer + verify + git safety | — |
| 4 | Journal | schema only |
| 5 | Visual detector | stub |
| 6 | CLI + config + packaging | arg parsing only |

Phase 3 is the product. Phases 4–6 make it shippable; phases 0–2 make it possible.

---

## Layout

```
packages/
  core/         contracts, state machine, safety — zero external deps
  detectors/    contract/ (API schema) · visual/ (Playwright + pixel)
  fixers/       harness/ (adapter) · noop/ (dev + tests)
  journal/      SQLite outcome store
  cli/          arg parsing, config loading
```

`core` depends on nothing and stays independently publishable. That is the test of
whether the dependency rule actually held.

---

## Safety invariants

Assertions in the engine, not guidelines. Each one is covered by a test.

1. A git checkpoint precedes every file mutation.
2. `HEALED` is reachable only via a passing re-run of the **originating** detector —
   never via the model's own claim of success.
3. Attempt cap per issue signature (default 2), then `ESCALATED`. Never a third try.
4. Patches touching files outside the configured allowlist are rejected **before**
   they are applied.
5. A dirty working tree blocks automatic changes unless explicitly overridden.
6. N consecutive failed heals trip the circuit breaker and halt the run.
7. `--dry-run` is a real code path, not a flag checked at the last moment.

---

## Develop

Requires Node >= 20.11 and pnpm 9.

```bash
pnpm install
pnpm build       # tsc project references, in dependency order
pnpm typecheck
pnpm test        # no network, no model calls
pnpm lint
```

---

## Deliberately not here

No dashboard, no auth or billing, no hosted relay, no vector similarity. Each is a
real option later; none of them makes a working loop arrive sooner, and every one is
easier to add against a working engine than to design around an imaginary one.
