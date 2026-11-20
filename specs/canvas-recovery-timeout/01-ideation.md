---
slug: canvas-recovery-timeout
number: 261119-052319
created: 2026-11-19
status: ideation
---

# Bound the canvas recovery test timeout

**Slug:** canvas-recovery-timeout

**Author:** Codex

**Date:** 2026-11-19

**Issue:** DOR-4757

---

## 1) Intent & Assumptions

- Keep the three durable identity-hold recovery tests reliable during full verification. DOR-4534 surfaced the failure.
- Preserve every assertion and fixture step. The tests must still prove retained accepted work, unchanged authority, and exactly one delivery after the hold clears.
- Keep the change in the single parameterized test group. Production behavior, authorization, billing, global timeouts, retries, CI configuration and other tests are outside this issue.

## 2) Pre-reading Log

- `AGENTS.md` and `specs/manifest.json` establish the Flow stage and artifact format.
- `apps/server/src/services/canvas/doc-channel/__tests__/pump-recovery-authority.test.ts:79–212` runs the same file-backed SQLite recovery sequence for `pending`, `in_doubt` and `failed`.
- `apps/server/src/services/canvas/doc-channel/writes/__tests__/reservation-bridge.test.ts:735` uses a scoped `loadCeilingMs` timeout for its cold-process cases.
- `packages/shared/src/test-budget.ts` defines a fixed ceiling for a test runner's per-case timeout. The current maximum multiplier is four.

## 3) Codebase Map

The fixture admits work, adds a durable identity hold, and checks that receipt, queue, staged context and batch inputs survive. It clears the hold, races two existing recovery pumps and uses a fake runtime to verify one nudge, one send, preserved context and durable settlement. Only the inserted hold status varies by case.

The affected test blob `3cfaf287c380ac1b2ae6570843298313e6f9adf8` is identical at DOR-4534 candidate `cdd77fdb71e3aed4d714dba2a75328f22680e01d`, its base `58919179e89e89944199f9cc991074e53e418e66` and published main `8ee317547876f16ded66d271016c515e88e14fe0`.

## 4) Root Cause Analysis

- The full DOR-4534 verification exited 1. The server suite passed 47,635 tests. The sole failing case, `in_doubt`, hit Vitest's default 5,000 ms timeout and reported 5,660 ms elapsed. The full log is in the DOR-4534 worktree at `.dork/flow/tmp/4534-verification-002/verify.stdout.log`.
- A separate guarded, one-worker, zero-retry replay on the unchanged DOR-4534 candidate passed all 14 cases in the file. The same `in_doubt` case took 431 ms.
- The failure establishes that the full run exceeded the default budget. The isolated result shows the failure is intermittent. The test body uses the same sequence for the other two statuses, so the evidence does not identify an `in_doubt`-specific product fault or prove that host load was the sole cause.

## 5) Research

Use `loadCeilingMs(5_000)` as the timeout for the three identity-hold cases. The current ceiling is 20 seconds per case. Successful cases return when their existing assertions finish, and a case that stalls past the ceiling still fails.

A global timeout would widen the budget for unrelated tests. Changing only the observed status would treat identical recovery work differently. Replacing fixed settles with dispatch and durable-settlement signals could improve determinism, but requires separate analysis of the negative and cleanup assertions. The current evidence supports the local budget change without that redesign.

## 6) Decisions

| Decision         | Choice                                      | Rationale                                                           |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| Timeout scope    | The three existing identity-hold cases      | All run the same SQLite and dispatcher work.                        |
| Timeout budget   | Existing shared helper with a 5,000 ms base | Gives a bounded test-runner ceiling without changing shared policy. |
| Behavioral proof | Keep fixture steps and assertions intact    | Preserve the hold, authority, retention and exactly-once checks.    |

At SPECIFY, record the one-file scope and verify the changed group with the normal guarded, one-worker, zero-retry offline file command. Keep the 14-case census and individual timings. A passing isolated run establishes the test behavior on that run. Any claim about performance under full-suite load requires evidence from that context.
