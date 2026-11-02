---
id: 261102-180949
title: The two-desktop Community journey runs on demand on a GitHub macOS runner, with Homebrew Postgres
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.community-two-desktop.journey
prs: []
ratchet-release: []
field-changes: []
---

## Why

DOR-2974 needs the two-desktop member journey (`apps/e2e/community-two-desktop`) run at a release tag, and the packaged app must never be launched on a person's Mac. Until now it only ran there. GitHub's macOS arm64 runners have no Docker, and the journey's Postgres was always a container.

## What changes

A new `workflow_dispatch` workflow, `community-two-desktop.yml`, takes a release tag. On `macos-15` it checks out the tag, copies this commit's journey script over the tag's, installs Homebrew Postgres, and runs the journey with `--build` in a throwaway home with `DORKOS_TEST_RUNTIME=true`. It uploads `receipt.json` and `steps.log`. It uses no secrets.

The journey gains `DORKOS_TWO_DESKTOP_PG_URL`: a superuser URL for a Postgres on this machine, used with the host's `psql` instead of Docker. It must be on this machine and name no database, and it can't be set together with `DORKOS_TWO_DESKTOP_PG_CONTAINER`. Docker stays the default.

## Hypothesis

Runs of the two-desktop journey on a person's Mac go from the only way to run it to 0 needed for DOR-2974's release checks, within 14 days of merge. QA reads it from the workflow's run list; no collector metric covers it yet.

Revert if the job can't finish a run at a release tag on the hosted runner.
