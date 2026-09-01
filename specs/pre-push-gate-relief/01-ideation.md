# Pre-push gate relief on shared-touching branches

- **Id:** 260901-200706
- **Work item:** DOR-1675 - Pre-push gate is near-unusable on shared-touching branches from a busy multi-agent machine
- **Stage:** IDEATE
- **Date:** 2026-09-01

## Intent

Make the lefthook pre-push test gate survivable on a branch that touches
`packages/shared` while several agents share the machine — without weakening
what the gate is for. Today such a branch turns `turbo test --affected` into
effectively the full monorepo, serial (`--concurrency=1`), ~14 minutes, and
every run is a fresh chance for a timing-sensitive test to flake under load
(measured: one clean branch needed three push attempts; another disclosed a
bypass; a 20-minute push on DOR-1665).

## Evidence base

- DOR-1653 push attempts (controlled with/without toggle table in the PR body),
  DOR-1665 (20-minute push), DOR-1654 (disclosed bypass), all during the
  DOR-1648 program on 2026-09-01, machine load 37–283.
- Known-sensitive tests named by the measurements:
  - `packages/shared/src/__tests__/atomic-write.test.ts` (concurrency timing)
  - `apps/client/src/dev/__tests__/every-showcase-mounts.test.tsx`
    (`testTimeout: 15_000` on a page measured at ~18s under load)
  - `apps/client/src/layers/features/command-palette/model/__tests__/use-preview-data.test.ts`

## What discovery found

1. **The gate has already been designed twice, deliberately.** The lefthook
   header records the philosophy: affected-only on purpose (DOR-617 — "a gate
   that cannot pass while the machine is busy is not a gate, it is a toll"),
   `--concurrency=1` on purpose (DOR-121 — vitest worker pools oversubscribe a
   14-core box ~9x otherwise), and a hard cache-key constraint (the passthrough
   must stay exactly `-- --run` so the gate shares turbo cache with the dev
   loop and CI). Any fix must respect all three.
2. **The flake absorber misses exactly the suites that flake.** The gate sets
   `VITEST_RETRY=2`, but only `apps/server/vitest.config.ts` and
   `packages/relay/vitest.config.ts` read it. `packages/shared` and
   `apps/client` — home of all three named flaky tests — never wire `retry`,
   so the gate's retry does nothing for them. This looks like an oversight,
   not a decision: the wiring comment in the server config says the variable
   exists "to absorb timing flake in integration tests at the gate", with no
   carve-out language for other packages.
3. **The merge queue is already the deciding gate.** Full-suite `test` and the
   Playwright shards run on `merge_group` as required checks; push-to-main
   re-runs nothing. The local pre-push gate is by design the fast/survivable
   half of a two-gate split, not the decider.
4. **The 14 minutes is structural, not incidental.** shared has ~all of the
   repo as dependents, so `--affected` on a shared-touching branch ≈ the full
   monorepo; serial execution multiplies that. No timeout tweak changes the
   wall-clock problem.

## Options considered

**A. Complete the `VITEST_RETRY` wiring (all vitest projects).**
Mechanical; kills the re-run-the-whole-gate cost of a single flake. Respects
the cache-key constraint (the env var rides `globalPassThroughEnv`, not
hashed). Does nothing for the 14-minute wall clock. Low risk: retry only
engages at the gate (`VITEST_RETRY` unset elsewhere), and CI deliberately does
not set it, so CI's honest verdict is unchanged.

**B. Raise/tune concurrency (static or load-aware).**
Rejected as primary: DOR-121's oversubscription reasoning still holds on a
busy box, and a load-aware knob adds machinery whose failure mode (gate
behaves differently per run) is worse than the disease. Not worth re-fighting
for a gate whose completeness is CI's job anyway.

**C. Scale escape hatch: downshift when "affected" ≈ "everything".**
When the affected-package count crosses a threshold, the gate prints an honest
notice and skips the run (or runs only the directly-changed package), naming
the merge queue as the deciding gate. Precedent already inside the same gate:
docs-only pushes run nothing; delete-only pushes run nothing. This directly
attacks the 14 minutes on exactly the branches where the local gate's signal
is weakest (cross-package combination breaks are explicitly documented as NOT
this gate's job).

**D. Codified bypass-with-disclosure policy.**
Documenting `LEFTHOOK=0` + a mandatory PR-body disclosure line. Weakest
option alone — it normalizes bypassing and pushes judgment onto each agent —
but worth writing down as the residual escape valve since bypasses already
happen and honest disclosure beats silent ones.

## Recommended direction

**A + C, in that order; D as a documented footnote; not B.**

1. Wire `retry: process.env.VITEST_RETRY ? Number(...) : 0` into every vitest
   project config (or hoist into a tiny shared helper), same comment style as
   the server config. Small PR, immediately removes the flake-tax on every
   push, no cache-key impact.
2. Add a scale escape to the pre-push command: count affected packages (turbo
   can report this cheaply via `turbo ls --affected` / dry-run JSON); above a
   threshold (proposed: >10 of the ~18 suites), print
   "Affected set ≈ full monorepo (<n> packages) — skipping the local gate;
   the merge queue runs the full suite" and exit 0. Keep the full run below
   the threshold. The threshold and the skip-vs-downshift choice (skip
   entirely vs run only the directly-touched packages) are the two dials to
   settle in SPECIFY.
3. Write the bypass-disclosure policy into the lefthook header + the
   creating-pull-requests skill: bypassing is acceptable only with a PR-body
   disclosure naming what was skipped.

## Open questions for SPECIFY

- Threshold value and whether the escape runs the directly-changed packages
  (fast, partial signal) or nothing (honest zero). Leaning: run
  directly-changed only — shared's own suite is ~seconds and is the code
  actually edited.
- Whether `every-showcase-mounts`'s 15s budget should also be raised outright
  (it is measured at ~18s under load — that is a real bound violation, not
  flake; retry alone re-runs a test that may deterministically exceed the
  bound under load).
- Whether the atomic-write 5s bound wants a load-proportional budget instead
  of retry.

## Out of scope

- Any change to CI/merge-queue gating (already correct).
- Re-litigating DOR-617 (affected-only) or DOR-121 (serial) — both stand.
- The `pnpm verify` dev-loop path (unchanged; it shares the cache either way).
