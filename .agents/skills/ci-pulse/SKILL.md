---
name: ci-pulse
description: "Collect CI Steward's pipeline numbers right now, locally, into a temporary directory, and show the ci-status screen from them, including this clone's local hook timings. Pushes nothing. Use when the daily snapshot is too old to answer the question."
disable-model-invocation: true
---

# /ci-pulse

The daily collector runs at 05:00 UTC. A pulse answers "what does it look like now" without waiting for it: the same `collect` the workflow runs, over yesterday (when the data branch lacks it) and today so far, plus this clone's local hook timings.

## Steps

1. Run it:

   ```bash
   pnpm ci:pulse
   ```

   It seeds a temporary directory from `origin/ci-steward-data` when that exists (run `git fetch origin ci-steward-data` first for the latest), collects through your `gh` login, computes verdicts, and prints the `/ci-status` screen. Add `--keep` to keep the directory and read the raw snapshot.

2. Relay it the way `/ci-status` does: health, the constraint, then notable verdicts.

## What it costs and what it never does

- It spends your own GitHub API allowance (5,000 requests an hour for a personal login): about 40 requests on a quiet day, a few hundred on a busy one, capped by `collect.api_budget` in `ci/config.yaml`.
- Today is a partial day, so its numbers move until midnight UTC.
- It never pushes to `ci-steward-data`, never creates it, and never writes a verdict anywhere but the temporary directory.
