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

![A terminal recording of one real run: the loop detects a failing check, proposes a fix through the agent harness, applies it, re-runs the same check, and reaches HEALED in 17.79 seconds](assets/self-heal-demo.gif)

One real run, unedited — 17.79s, one attempt, no human. The pause between
`PROPOSING` and `APPLYING` is the harness editing a disposable sandbox; the patch is
read back out of git rather than parsed from what the model says it changed.

```bash
pnpm build && pnpm demo        # dry run — nothing written, no model called
pnpm build && pnpm demo:heal   # the real thing, using your agent harness

pnpm demo --fixture orders-total-dropped --heal   # the API contract bug
pnpm demo --list                                  # every fixture
```

Two detector kinds now run through the same unmodified engine — an exit code, and an
API response compared against a recorded contract:

```
   15234ms  HEALED

- return orders.map(({ id, customer, currency })    => ({ id, customer, currency }));
+ return orders.map(({ id, customer, total, currency }) => ({ id, customer, total, currency }));
```

| Phase | Deliverable | State |
|---|---|---|
| 0 | Harness invocation spike | **done** — patch captured from git, not from the model |
| 1 | Runner + safety + `noop` fixer | **done** — all 7 invariants covered |
| 2 | Schema-drift detector | **done** — detects *and* heals a dropped API field |
| 3 | Detected and fixed with no human | **done early** — the timeline above |
| 4 | Journal | port + replay path exist; SQLite pending |
| 5 | Visual detector | stub — every method throws |
| 6 | CLI + config + packaging | runs both detector kinds; ships the noop fixer |

81 tests, no network, no model calls.

Phase 3 arrived early because phase 0 built the harness adapter as real code rather
than as a throwaway spike, so wiring it in was a one-line swap. Phase 2 was the test
of whether that boundary was real: a detector needing a running server, a recorded
baseline, on-disk artifacts, and partial equality was added without the engine
changing. `core` gained one primitive (`startProcess`) and no knowledge of HTTP.

---

## Layout

```
packages/
  core/         contracts, runner, safety, process + git — zero external deps
  detectors/    command/ (exit codes) · contract/ (API schema) · visual/ (stub)
  fixers/       harness/ (drives your agent CLI) · noop/ (dev + tests)
  journal/      SQLite outcome store — interface only, phase 4
  testkit/      sandboxes, fixtures, servers, measurement — shared by everything
  cli/          arg parsing, config loading
scripts/
  demo.mjs            the narrated loop, dry or live, any fixture
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

## API contracts

A recorded contract is the shape of a response with every value discarded — which
fields exist and what type each holds. It is written to `.self-heal/contracts/` the
first time an endpoint is seen, and **committed like source**. A human reviewed it
once; everything after that is machinery noticing when reality stops matching it.

```json
{
  "contracts": {
    "endpoints": [
      { "url": "http://127.0.0.1:3000/api/orders", "editable": ["src/api/**/*.ts"] }
    ],
    "server": {
      "command": "npm",
      "args": ["run", "dev"],
      "readyUrl": "http://127.0.0.1:3000/api/health"
    }
  }
}
```

The server is booted fresh for detection and again for verification. A process
started before the fix would still be serving the old code, and re-probing it would
report `HEALED` for a patch that changed nothing (D-011).

Removing a field is drift. Adding one is not, unless you set `"strict": true` —
a detector that fires on every shipped feature is a detector people mute (D-010).

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
