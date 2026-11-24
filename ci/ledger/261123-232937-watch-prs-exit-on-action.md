---
id: 261123-232937
title: watch-prs.sh exits when a PR needs action, so a background watcher wakes its agent
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-2558. A harness tells an agent about a background shell only when it exits, and
`watch-prs.sh` kept looping after a PR needed action, so its right next step landed in
a file nobody read: #2333 and #2335 sat ejected and conflicting for hours. Off a TTY
the watcher now finishes the cycle, prints one `NEEDS ACTION` line and exits 10 once
a PR is ejected, conflicting, failing, cancelled, green with auto-merge off, or the
watcher is blind. `--no-exit-on-action` keeps the old stream.

`UNARMED_CLEAN` is renamed `AUTO_MERGE_OFF`, and accepts `UNSTABLE` (only the excluded
Vercel check red) as green. Its remedy reads main's `ci/required-checks.json` the way
`scripts/open-pr.sh` does: while main requires `not-held`, `release-window` and
`pr-gates`, turn auto-merge back on; otherwise the maintainer merges. Every queue
removal since the last commit is counted and carries its reason:
`AUTO_MERGE_OFF(ejected,k)` gives the ejection rule (k=1 re-queue once if not yours,
k>=2 fix and push), and `AUTO_MERGE_OFF(dequeued,reason)` after a manual or timed-out
removal comes with no re-queue command. No remedy names merge-tail, arm-door or arm.sh
any more (DOR-5124).

Hygiene: the watcher is a local tool and changes no required check, retry, shard or
timeout. Its fixtures stay in `scripts-test`'s `fixtures` step. Measured locally on
Nov 23 at a 1-minute load of about 70 (so both numbers are inflated): the suite took
9.8 to 14.1 s before and 22.3 to 24.1 s after, three runs each, so it adds roughly
10 to 14 s to a job whose ceiling is 10 minutes. No metric in `ci/metrics.yaml`
measures how long a PR waits for its author after it needs action; that metric is a
follow-up. Revert if agents are woken for states they cannot act on, or the
pseudo-terminal cells prove flaky on the Linux runners.
