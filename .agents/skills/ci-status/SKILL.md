---
name: ci-status
description: "Show CI Steward's one-screen view of the pipeline: the SLO table, the one constraint to work on, the open improvement triggers, every ledger experiment with its computed verdict, and the collector's health. Reads the ci-steward-data branch; run it before changing CI or when asked how CI is doing."
disable-model-invocation: true
---

# /ci-status

The first stop before any pipeline change (`contributing/ci.md`). It joins the ledger on this checkout (`ci/ledger/`) with what the daily collector computed on the `ci-steward-data` branch.

## Steps

1. Bring the data branch up to date. This is the only network step, and a failure is fine (the branch may not exist yet):

   ```bash
   git fetch --quiet origin ci-steward-data || true
   ```

2. Show the screen:

   ```bash
   pnpm ci:status
   ```

   It reads `origin/ci-steward-data` through git objects only. When the branch does not exist yet, it says so plainly and points at `pnpm ci:pulse`.

3. Relay it briefly: health first (anything `FAILED` or a snapshot over 2 days old is the headline), then the constraint, then any red trigger, then any verdict that is `failed`, `partial` or `inconclusive`. Do not restate the whole table.

4. If the person wants the picture rather than the numbers, build the day's page and open it:

   ```bash
   pnpm ci:report --open
   ```

   It writes to a temp path, never to the data branch, and never pushes.

## Reading it

- **Health FAILED** means the collector's own numbers cannot be trusted (a truncated fetch, a drifted ruleset, a missing data-branch safeguard, a stale local export). Each failure line names its fix. It is the constraint until it is fixed.
- **insufficient** is a thin sample, not a breach or a win. **unmeasured** means the SLO has no data source yet.
- **Verdicts** are computed by code, never written by hand: `verified` (reached the target), `partial` (at least halfway from the baseline, short of the target), `failed`, `inconclusive` (a confounding change on the same gate, or too little data), `pending` (the after-window is still open).
- **Triggers** are computed from the data, not written by a model: what fired, with its numbers, and a suggested next step. `red` means act; `amber` means decide. Each says how long it has been open and whether a `proposed` ledger entry already covers it. A trigger opens no pull request and changes nothing by itself.
- The day's report is `git show origin/ci-steward-data:reports/<YYYY-MM-DD>.html` (or `pnpm ci:report`); the Monday deep summary is `:reports/<YYYY-Www>.md`.
