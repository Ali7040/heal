# self-heal

[![ci](https://github.com/Ali7040/heal/actions/workflows/ci.yml/badge.svg)](https://github.com/Ali7040/heal/actions/workflows/ci.yml)

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

pnpm demo --fixture orders-total-dropped --heal     # the API contract bug
pnpm demo --fixture chart-colour-collision --heal   # the visual regression
pnpm build && pnpm demo:journal                     # heal it, break it, watch it replay
pnpm demo --list                                    # every fixture
```

Whether a change actually makes fixes cheaper or likelier is measured, not argued:

```bash
pnpm bench                                     # free: prompt size per fixture, no model
pnpm bench:live --runs 5                       # heal rate, attempts, $/heal, time
node scripts/bench.mjs --live --compare .self-heal/bench/<before>.json
```

Every run is cold — a fresh repository and no journal — because a replay costs
nothing and would only hide the model path being measured. Cost is reported per
*heal*, not per run, and a harness that does not report its cost shows `—`, never
`$0`.

The second time it sees a bug, it does not ask a model:

```
The loop                            The same bug, a second time
  18074ms  HEALED                     18796ms  REPLAY
  attempts: 1  total: 18052ms         18943ms  HEALED {"replayed":true}
                                      model calls this run: 0   total: 305ms
```

Three kinds of measurement now run through the same unmodified engine:

| Detector | Measures | Catches |
|---|---|---|
| `command` | an exit code | anything a test, linter, or type checker can fail on |
| `contract` | a JSON response against a recorded shape | a field that quietly stopped being returned |
| `visual` | pixels against an approved baseline | a picture that is simply wrong |

The last two are regressions nothing else notices — a valid 200 response, a passing
test suite, and the wrong output:

```
- return orders.map(({ id, customer, currency }) => ({ id, customer, currency }));
+ return orders.map(({ id, customer, total, currency }) => ({ id, customer, total, currency }));

- refunds: [30, 120, 220],     // the revenue blue, pasted by mistake
+ refunds: [230, 160, 40],
```

| Phase | Deliverable | State |
|---|---|---|
| 0 | Harness invocation spike | **done** — patch captured from git, not from the model |
| 1 | Runner + safety + `noop` fixer | **done** — all 7 invariants covered |
| 2 | Schema-drift detector | **done** — detects *and* heals a dropped API field |
| 3 | Detected and fixed with no human | **done early** — the timeline above |
| 4 | Journal | **done** — a repeat regression heals in 305ms for $0 |
| 5 | Visual detector | **done** — a colour regression detected and healed |
| 6 | CLI + config + packaging | **done** — `self-heal run` heals a real repo |
| 7 | Published | **done** — `npx self-heal`, verified by installing the tarballs |

145 tests on Linux and Windows, no network, no model calls. Windows is in CI
rather than an afterthought: the two worst bugs in this repository's history were
both `cmd.exe` re-parsing a command line, and both were invisible on Linux.

Phase 3 arrived early because phase 0 built the harness adapter as real code rather
than as a throwaway spike, so wiring it in was a one-line swap. Phase 2 was the test
of whether that boundary was real: a detector needing a running server, a recorded
baseline, on-disk artifacts, and partial equality was added without the engine
changing. `core` gained one primitive (`startProcess`) and no knowledge of HTTP.
Phase 5 asked the harder version of the same question — does that second detector's
shape generalise, or was it a coincidence? The engine needed nothing new at all;
one helper moved *into* `core` because a second caller wanted it (D-014).

---

## Use it

```bash
npx self-heal init      # or: npm i -g self-heal
```

Node >= 20.11, and a git repository. The journal wants Node >= 22.5
(`node:sqlite`); on anything older it turns itself off and says so, and the loop
still works at full price.

```bash
self-heal init          # writes a config and gitignores run artifacts
self-heal run --dry-run # detect, diagnose, propose — nothing written, nothing spent
self-heal run           # the real thing
self-heal run --only contracts   # just one detector, while iterating on it
self-heal journal       # what it remembers, and what that has saved
self-heal stats         # what it has spent, and what that bought
self-heal stats --since 7d
```

Every run ends with what it spent (`spent this run: $0.0412 over 2 model call(s)`),
and `stats` adds it up from the journal: model calls, heals, cost per heal, and an
estimate of what replays saved. Cost per heal counts every call, failed ones
included. A harness that does not report its cost is shown as "at least $x",
never as `$0`.

`run` drives the agent harness you already have installed, so it costs whatever
your harness costs. `--dry-run` and `--fixer noop` are free, and detect and report
exactly the same issues.

A failing command's output is read for `file:line` references — tsc, eslint,
vitest/jest/node stack traces, pytest and Python tracebacks, go, rustc — and the
model is shown the function each one points into, rather than a whole file. A
reference to anything that is not a file in your repository is ignored, and files
the check may edit are ranked above the test that noticed.

`--only` narrows a run to named detectors, so iterating on one does not pay for a
server boot and a screenshot every loop. A name matching nothing is an error, not
an empty run — a typo that silently measured nothing would report zero issues,
which is the one output this tool must never produce.

Every proposal happens in a copy of your repository in the OS temp directory,
built from `git ls-files` — so your `.gitignore` decides what a model can see, and
nothing it does outlives the attempt. A checkpoint precedes every write, a dirty
tree stops the run, and `HEALED` still means only one thing: the check that found
the problem passes now.

A fix must also break nothing else. Once it passes its own check, every detector
runs again; if any check that was passing now fails, the fix is reverted and the
retry is told what it broke. A check that was already failing does not count
against it. This costs one full detection per fix — `"collateral": false` in the
config turns it off, and `--only` narrows it along with everything else.

When the loop gives up on an issue (`ESCALATED`), it does not hand you a one-line
reason. It writes `.self-heal/evidence/escalations/<signature>.md`: what was
measured, the code the model was shown, every attempt as a diff with the measured
reason it failed, and where to start — patterns in the failures, such as every
attempt editing the same file or a proposal reaching for a protected test. The run
report links to it.

What a run leaves in your history is one commit per verified fix, authored by
`self-heal` and named for what it fixed — so each can be reviewed or reverted on
its own (`git log --author=self-heal`). A failed attempt leaves nothing: no empty
checkpoint commits, no dirty files. When one fix also cures another issue (a type
error that was failing the tests too), the second is re-measured and reported
`RESOLVED` without a model call.

---

## Layout

```
packages/
  core/         contracts, runner, safety, process + git — zero external deps
  detectors/    command/ (exit codes) · contract/ (API schema) · visual/ (pixels)
  fixers/       harness/ (drives your agent CLI) · noop/ (dev + tests)
  journal/      SQLite outcome store — node:sqlite, zero deps
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
8. A patch may never touch what the checks measure against — tests, baselines,
   recorded contracts, `.self-heal/`, the config — whatever the allowlist says. A
   fix that edits the measurement makes the check pass without fixing anything.

Test files are protected by default (`*.test.*`, `*.spec.*`, `*_test.*`,
`test_*.py`, `__tests__/`, `test/`, `tests/`). Set `"protected"` in the config to
replace that list; `.self-heal/` and the config file stay protected regardless.

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

## The journal

A record of **measured** outcomes, in SQLite at `.self-heal/journal.sqlite`.
`verified` is written by the detector's re-run, never by a model's claim.

A hit is a cheaper first guess, not a shortcut. A remembered patch is checkpointed,
allowlist-checked, applied, and then re-measured exactly like a fresh proposal — so
a stale patch can never cost correctness (D-012). Only verified patches are
offered, and one that stops working is demoted on its next failure.

A remembered patch also records the exact file it was made against. Once that file
has changed, the patch is not replayed — writing old contents onto a newer file
would quietly undo the newer work — and a fresh fix is proposed instead (D-020).

Backed by `node:sqlite`, so there is no native module to compile and no dependency
to install — at the cost of needing Node 22.5+. On anything older the journal turns
itself off with a message and the loop runs at full price. `--no-journal` does the
same on purpose.

```bash
self-heal journal                   # ✔ fa0f950f  check-failed  src/pricing.mjs
self-heal journal --forget fa0f950f # stop offering that one; propose fresh instead
```

`--forget` takes the short signature the listing prints, and refuses an ambiguous
prefix rather than deleting the wrong remembered fix.

---

## Visual regressions

A baseline is a PNG of a view that someone approved, recorded to
`.self-heal/baselines/` and **committed**. Reviewing it in a pull request is the
one moment human judgement enters the loop.

```json
{
  "visual": {
    "views": [{ "url": "http://127.0.0.1:3000/chart.png", "editable": ["src/chart/**"] }],
    "server": { "command": "npm", "args": ["run", "dev"], "readyUrl": "http://127.0.0.1:3000/health" }
  }
}
```

Comparison uses two thresholds: `tolerance` (how different one pixel must be to
count) absorbs antialiasing, and `maxRatio` (how much of the image may count)
absorbs a cursor or a scrollbar. Byte equality would report a regression on every
run of identical code.

PNG decoding is hand-written on `node:zlib`, so there is no native image module to
compile (D-015). Images come from a `Screenshotter` — a URL by default; a real
browser via the optional Playwright adapter.

---

## Develop

Requires Node >= 20.11 and pnpm 9. The journal additionally needs Node >= 22.5
(`node:sqlite`); on anything older it turns itself off and the loop still works.

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
