---
id: 261104-084830
title: An on-demand macOS reading of the Agent browser's flags and http behaviour, for one commit's CLI tarball
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.mac-browser-reading.read
prs: []
ratchet-release: []
field-changes: []
---

## Why

The Playwright alpha in #3511 (DOR-3884) stopped disabling Chromium's `HttpsUpgrades`. In sealed Linux Docker on 2026-11-04, http:// pages became https://, and an http-only host gave 409 `navigation_uncertain` or a warning an agent can't read. Nothing on main reads this on a Mac, and no browser may launch on the team's Mac login. The other way to read it was a person's sitting.

## What changes

- **A new `workflow_dispatch` job, `mac-browser-reading`, on `macos-latest`.** It takes an exact commit, fetches CI's `cli-tarball` for it, and runs it on the test runtime with no account and no secrets, adding one scripted turn to the installed bundle.
- **Six rows, made-up hosts in the runner's `/etc/hosts`:** an http-only host and a host with both, person opens and agent navigates; then the running flags of the agent's window and the plain window. Red unless every row is present and passed.
- **Nothing else changes.** Not required, no PR or queue trigger, and no effect on any gate that runs today. It holds a macOS runner only when someone dispatches it.
- **`timeout-minutes: 25` is generous.** Two self-test runs on 2026-11-04 took under 4 minutes each. Lower it once there are more runs.

Revert if it's dispatched and never read, or if it blocks a release by holding a macOS runner.
