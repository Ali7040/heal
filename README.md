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

**The loop closes.** A real bug is detected by a deterministic check, fixed with no
human, and verified by re-running that same check.

```
     277ms  DETECTING
     586ms  TRIAGING
     587ms  DIAGNOSING
     589ms  CHECKPOINTING
    2251ms  PROPOSING
   29061ms  APPLYING      {"edits":1}
   29068ms  VERIFYING
   29304ms  HEALED

  HEALED — verified by the originating detector
```

```bash
pnpm build && pnpm demo        # dry run — nothing written, no model called
pnpm build && pnpm demo:heal   # the real thing, using your agent harness
```

| Phase | Deliverable | State |
|---|---|---|
| 0 | Harness invocation spike | **done** — patch captured from git, not from the model |
| 1 | Runner + safety + `noop` fixer | **done** — 47 tests, all 7 invariants covered |
| 2 | Schema-drift detector | not started |
| 3 | Detected and fixed with no human | **done early** — the timeline above |
| 4 | Journal | port + replay path exist; SQLite pending |
| 5 | Visual detector | stub |
| 6 | CLI + config + packaging | runs; ships the noop fixer |

Phase 3 arrived early because phase 0 built the harness adapter as real code rather
than as a throwaway spike, so wiring it in was a one-line swap.

---

## Layout

```
packages/
  core/         contracts, runner, safety, process + git — zero external deps
  detectors/    command/ (exit codes) · contract/ (API schema) · visual/ (pixels)
  fixers/       harness/ (drives your agent CLI) · noop/ (dev + tests)
  journal/      SQLite outcome store
  testkit/      sandboxes, fixtures, measurement — shared by everything
  cli/          arg parsing, config loading
scripts/
  demo.mjs            the narrated loop, dry or live
  harness-probe.mjs   repeatable experiment: can we drive a harness and capture a patch?
```

Code is organized by what it does, not by which phase produced it. Phases are a
schedule; they end, and the code outlives them.

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
