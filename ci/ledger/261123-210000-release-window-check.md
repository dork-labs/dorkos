---
id: 261123-210000
title: A release-window check enforces freezes and releases in the cloud, replacing the arm script's FREEZE and release rules
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.release-window.release-window
  - wf.release-window-refresh.refresh
prs: []
ratchet-release: []
field-changes: []
---

Step 2 of DOR-5098 (every merge gate in the cloud, then auto-merge at PR open), ticket DOR-5102.
Three release rules lived only in `.temp/coord/arm.sh`, so they held only while one laptop armed
every PR:

- **Freeze:** while `.temp/coord/FREEZE` exists, only the PR on its first line may be armed (PM
  10-27, after #3227 slipped in ahead of #3228).
- **Release alone:** a release PR enters the queue alone.
- **Release goes first:** no other PR is armed until main's VERSION is on npm (#4083).

`scripts/release-window-check.sh` holds all three, and `.github/workflows/release-window.yml`
runs it on PRs and on every merge-queue entry:

- The freeze is now the `MERGE_FREEZE` repository variable, "<pr> <reason>" or "- <reason>". A
  variable can always be cleared, unlike a file on main, which would need a PR that the freeze
  itself blocks.
- A release is a PR that changes VERSION. Its queue entry must hold exactly one commit.
- Any other PR fails while the VERSION it would land on is not on npm. On a queue entry that means
  the group head's VERSION, so a PR queued behind a release waits too.

GitHub raises no event when a variable is cleared or a version reaches npm, so
`release-window-refresh.yml` re-runs failed checks once the window is open. It runs after Release
Publish, after each push to main, by hand, and every 15 minutes as a backstop.

The check lands advisory. Dorian adds `release-window` to the ruleset once it has reported on PRs
and queue entries. The release lane then sets `MERGE_FREEZE` instead of writing FREEZE.

Known limit: a PR already in the queue when a freeze starts fails its next queue build and is
removed. DOR-5107's re-arming has to cover that.

Hygiene, not an experiment: it moves a gate off the laptop rather than moving a metric. It serves
`tracked.green-to-armed` (baseline p50 21.4 min, target 0). Revert if it goes red with no freeze
and main's version on npm, or if it fails to report on a queue entry.
