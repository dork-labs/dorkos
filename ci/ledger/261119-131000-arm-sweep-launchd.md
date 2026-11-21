---
id: 261119-131000
title: arming moves to a launchd sweep that runs arm.sh every 5 minutes; merge-tail stays off for arming
kind: experiment
status: proposed
actor: agent
gates: []
prs: []
hypothesis:
  metric: 'tracked.green-to-armed'
  slo: 'lead-time'
  baseline: 21.4
  baseline_source: "measured 2026-11-19 by ci-steward over the 117 PRs merged in the 48 h to 11:50Z, from each PR's timeline: security-reviewed label to added_to_merge_queue was p50 21.4 min, p75 84.3, p90 261.5, max 1871; 42 of 117 waited over 60 min. It is an upper bound on arming delay (it also holds CI still running, holds and QA). Queue to merge was p50 26.4 min, so arming wait was about half of a typical PR's lead time."
  target: 10
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4190 program; asked by Dorian on Nov 19 ("merge-tail is the weak spot"), decided by ci-steward
with DorkOS Code. Nothing in this entry is live until Security OKs the two drafted files and Code
loads the agent.

**The problem.** Three things arm a ready PR, and each had a hole:

- merge-tail (GitHub `schedule: */10`) was throttled to a 162 min p50 gap (ledger 260919-204500)
  and once ran nothing for 20 h. It is `disabled_manually` since 2026-11-18 because it queued
  #3934 eight seconds before QA's sign-off. It cannot see arm.sh's local gates (Security's review
  files, waivers, FREEZE, the local verify record) and never will from a GitHub runner.
- Code's arm timer watches only the PRs it is told about, and dies on every DorkOS restart. On
  Nov 18, 22 PRs sat with nothing armed.
- arm-sweep-v2 (a DorkOS task, every 10 min, Nov 1) was disabled on Nov 1 after unattended runs
  could not get Bash approved, and it still looks for Security's old review-file name, so today it
  would skip every PR.

The verify-proof bottleneck that stalled ready PRs on Nov 18 is already fixed: arm.sh accepts a
CI-green proof (DOR-4694, ci-proof.sh, live since Nov 19 05:52).

**Options weighed** (research with sources in this PR's description):

| option                                                                                                                                            | verdict                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fix merge-tail's trigger: event-driven `workflow_run` or `labeled` (this ledger's 260919-204500), or an external cron calling `workflow_dispatch` | Rejected. Faster ticks don't fix the real flaw, which is that a GitHub runner can't see arm.sh's local gates, so it can arm what arm.sh would refuse (#3934). `workflow_run` and `pull_request_target` also hold write tokens next to PR data.                   |
| Every gate a required status check posted by a GitHub App, with auto-merge on at PR open                                                          | The right end state, and the industry norm (Mergify and Bulldozer generalise it). Deferred: it needs the gates on GitHub, and a label can't be trusted while every agent shares one login (DOR-3183, per-role Apps). arm-door (261118-183332) is its first half. |
| Mergify, Kodiak, Bulldozer or Aviator                                                                                                             | Rejected for now. They're paid or self-hosted, replace or sit beside the native queue, and still can't see local gates.                                                                                                                                          |
| A DorkOS task running the sweep (re-enable arm-sweep-v2)                                                                                          | Rejected. It spends a model turn every tick, needs Bash approval unattended (its Nov 1 failure), and depends on DorkOS being up.                                                                                                                                 |
| **A launchd agent running a sweep that only calls arm.sh**                                                                                        | **Chosen.** Every gate stays arm.sh's, nothing new is trusted, it survives DorkOS restarts, it costs no model turns, and its cadence is the Mac's, not GitHub's.                                                                                                 |
| Do nothing                                                                                                                                        | Rejected: about half of a PR's lead time is arming wait.                                                                                                                                                                                                         |

**The change.** `.temp/coord/arm-sweep-v3.sh` (draft `arm-sweep-v3.sh.draft-1119`) does one pass:
open PRs into main, not drafts, with `security-reviewed` and no hold-type label, not armed or
queued, MERGEABLE (UNKNOWN re-read up to 3 times, as #3937 does). Each goes to arm.sh with its head
SHA, which runs every gate. It passes `--security-sha-ok` only when Security's review file for this
head exists under either name; arm.sh's review-file-check.sh remains the authority. A refusal is
logged once per head and reason, and each pass writes a heartbeat line. A lock stops two passes
overlapping. `--dry-run` arms nothing. launchd agent `ai.dorkos.arm-sweep` (draft
`ai.dorkos.arm-sweep.plist.draft-1119`) runs it every 300 s, and before each run it checks the
script against a pinned sha256, refusing on any drift.

Dry run at 13:02Z: 9 candidates (#4022, #4018, #4017, #3999, #3996, #3994, #3989, #3988, #3983)
would have gone to arm.sh, and #3823 was skipped as conflicting. While FREEZE is on, arm.sh refuses
each one, and the sweep logs each once.

merge-tail stays disabled for arming. Its other duty, re-requesting lost Claude reviews, has also
been off since Nov 18; whether to bring that back alone is a separate call for Code.

Expected within 14 days: `tracked.green-to-armed` p50 under 10 min, and no PR ready for over 15
min with nothing in the heartbeat log refusing it. Revert if the sweep ever arms a PR arm.sh would
refuse by hand (it can't by construction, so that would be a bug), or if its passes overlap or
stall for more than an hour.
