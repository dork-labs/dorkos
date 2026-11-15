---
id: 261113-011220
title: Browser shards balanced again with fresh spec times, chat-mock in four files and the CPU logged
kind: experiment
status: proposed
actor: agent
gates: [wf.browser-test.browser-shard]
prs: []
hypothesis:
  metric: gate.wf.browser-test.browser-shard.duration_p90@merge_group
  slo: queue-build
  baseline: 23.6
  baseline_source: 'Job durations of the 18 browser-shard jobs in green merge-group runs 43306568738, 43329600710 and 43337348123 (2026-11-12, all after #3661 and #3650); nearest-rank p90 23.6 minutes, per-run maxima 23.6 / 23.9 / 23.0. The steward snapshot of 2026-11-11 (p90 30.50, n=132) predates those two merges and overstates today.'
  target: 22.0
  after_days: 7
ratchet-release: []
field-changes: []
---

Refs DOR-4190. Codebase Cleanup's CI target is 12 minutes per merge, and
`browser-test` was the long pole in 4 of the last 10 merges.

**Why the shards were uneven.** On those three runs, shard 2's tests took
16.3–17.1 minutes against 11.0–12.5 on shard 1, every time. Two causes, both in
the data the balancer reads (`apps/e2e/reporters/balanced-shard.ts`):

- `chat-mock.spec.ts` and its nine registered modules were ONE unit of about 8.7
  minutes. The balancer never splits a spec file, so one shard always started
  with it.
- `reporters/shard-timings.json` (from 2026-11-09) had drifted. chat-mock was
  stored at 405 s and ran 519 s; `connections.spec.ts` was stored at 203 s and
  ran 302 s.

**What changes.**

- `shard-timings.json` refreshed with `pnpm --filter @dorkos/e2e shard-timings`
  from the 7 latest green queue runs (43301761279 … 43337348123).
- `chat-mock.spec.ts` keeps its inline suites (about 154 s); its registered
  modules move into `chat-mock-prompts.spec.ts` (about 153 s),
  `chat-mock-turns.spec.ts` (136 s) and `chat-mock-session.spec.ts` (82 s). The
  shared reset-and-seed hooks move into `tests/chat/mock-server.ts`.
  `chromium-mock` gains `workers: 1`, so local runs stay one file at a time
  (CI already runs one worker), and both its match and the cockpit project's
  ignore become `**/chat-mock*.spec.ts`, so no mock file can reach the billable
  leg. The same 56 tests are collected, all in `chromium-mock`.
- `scripts/assert-browser-tests-executed.sh` also credits a test to the spec file
  that loaded it, so a spec made only of register calls counts as having run;
  the run's total still counts each test once. Two new fixture cases
  (`scripts/test-assert-browser-tests-executed.sh`); the first fails on the old
  script.
- `browser-shard` logs its runner's CPU, as the unit shards do. On the unit
  side the same work takes up to 1.65x longer on one hosted CPU than another.

Simulated with the balancer's own code over the new collection: every shard
13.1 estimated test-minutes, the heaviest single unit 288 s (it was 519 s).
Estimates leave out setup, boot and CPU variation, so this is not a measured
wall-time win. No retries, shards, timeouts or required checks change.

Revert if the slowest browser shard does not come down, or if any chat-mock
file flakes on a reset it no longer shares a file with.
