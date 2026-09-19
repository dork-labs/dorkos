---
name: ci-local-export
description: "Daily CI Steward job: export this clone's git hook timings (how long git commit and git push took, and which pushes were killed at the tool ceiling) to the ci-steward-data branch, then trim the local timings file. A DorkOS scheduled skill that runs pnpm ci:local-export."
disable-model-invocation: true
schedule:
  cron: '30 4 * * *'
  timezone: UTC
  max-runtime: 10m
---

# ci-local-export

The lefthook time-wrap (`packages/ci-steward/bin/time-wrap.sh`) records a START and an END line for every hook command in `$(git rev-parse --git-common-dir)/ci-steward/local-timings.jsonl`. That file lives only on this machine, so a GitHub Actions job cannot read it. This job pushes one aggregate per finished day to `local/<clone>/YYYY-MM-DD.json` on the `ci-steward-data` branch, where the daily collector turns it into the `local-commit` and `local-push` SLOs. It runs at 04:30 UTC, half an hour before the collector.

## Run

```bash
pnpm ci:local-export
```

Then report its output in one or two lines: how many days it exported, whether it pushed, and whether it rotated the file. It never needs anything else.

## What it does

1. Reads the timings file and pairs each START with its END. An END with a signal status (128 + HUP, INT or TERM) is a killed run, and so is a START with no END older than `local.killed_after_seconds` in `ci/config.yaml` (the pre-push watchdog's ceiling plus margin); a younger unmatched START might still be running and is left for tomorrow.
2. Writes each finished day under `local/<clone>/`. The clone name is a short digest of this machine and this clone, never the hostname (the branch is public); set `CI_STEWARD_CLONE` or pass `--clone <name>` to choose one.
3. Pushes with fetch, rebase and retry. It never creates the branch: before the collector's first run it says so and pushes nothing.
4. Writes a heartbeat, `local/<clone>/exported.json`, on every run, so an idle clone (no commits, no pushes) never reads as a stale export.
5. Rotates the file: lines older than 30 days go, and past 5 MB the oldest half goes. Lines appended while it rewrites are kept.

## Approving it

DorkOS finds the `schedule:` block above and puts this job on the **Schedules** page as **Waiting for approval**. It does not run until the operator approves it. Approve it with **Approve at Full autonomy**: the job runs Bash and `git push`, and a schedule that arrives in a file is held back to the careful setting, which cannot run either unattended (DOR-2100; `docs/guides/task-scheduler.mdx`). With plain Approve, every run ends Blocked.

If exports stop, the collector notices: an export older than 3 days is a health failure on the daily snapshot, and the SessionStart line says so.
