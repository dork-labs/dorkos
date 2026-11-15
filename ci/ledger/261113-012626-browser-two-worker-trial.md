---
id: 261113-012626
title: A dispatch-only lever to trial two cockpit workers per browser shard
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.browser-test.browser-shard
prs: []
ratchet-release: []
field-changes: []
---

## Why

Refs DOR-4190. The browser suite runs one test at a time per shard (`workers: 1`
in CI) on 4-core runners, and the cockpit project `chromium` is about half of
its test time. The PM ruled (2026-11-12) to trial two cockpit tests at a time in
CI before any gate uses it, and to fall back to 8 shards if flakes rise.

## What changes

- **`playwright.config.ts`:** CI's worker count comes from
  `E2E_CHROMIUM_WORKERS`, which must be `1` or `2` (anything else stops the run
  with an error) and is 1 when unset. Every other project gets `workers: 1` in CI,
  so the extra worker can only ever hold a cockpit test. Local runs are unchanged.
- **`browser-test.yml`:** `workflow_dispatch` gains a `chromium_workers` choice
  input (`1` or `2`, default `1`). Only the full shards' suite step reads it, and
  only on `workflow_dispatch`; every other event runs 1, as before.
- **Nothing changes for any gate.** A PR run, a queue build and the scheduled
  canary all still run one worker. The existing canary guard keeps a dispatch on
  `main` only, so a trial never posts on a PR head or a queue build.

## The trial

Five dispatches on `main` with `chromium_workers=2`, after this lands. A dispatch
on a branch is refused by design (it would post the required check's name on that
branch), and a PR run only exercises the smoke shards, so `main` is the one place
the full suite can run this way without touching a gate.

**Baseline:** 0 flaky tests (`status: "flaky"`, failed then passed on retry) in
4,375 test results across the 7 green queue runs 43301761279 … 43337348123
(2026-11-12). The 9 red `browser-test` queue runs since 2026-11-11 were one
cluster of real failures between 00:40 and 01:31 UTC on 2026-11-12, not flakes.
**Shard time now:** slowest-shard p90 23.6 minutes (ledger 261113-011220).

**What it must show:** zero new flaky or failed tests across the five runs, and
the slowest shard's job time down. If any test flakes that did not before, the
PM's fallback (8 shards) applies, and this lever stays at 1.

**What config cannot stop:** Playwright has no cap for a GROUP of projects, so at
2 a cockpit test can run beside a test-mode test, and two test-mode projects can
run beside each other on their shared test-mode server, where `POST
/api/test/reset` is global. Local runs already allow that. The trial is what
measures it in CI.

Revert if a dispatch with the default ever runs two workers.
