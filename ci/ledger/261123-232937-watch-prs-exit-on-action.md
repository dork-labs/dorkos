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
the watcher now finishes the cycle, prints one `NEEDS ACTION` line and exits 5 once a
PR is ejected, conflicting, failing, cancelled, green with auto-merge off, or the
watcher is blind. `--no-exit-on-action` keeps the old stream.

`UNARMED_CLEAN` is renamed `AUTO_MERGE_OFF`. Its remedy reads main's
`ci/required-checks.json` the way `scripts/open-pr.sh` does: once main requires
`not-held`, `release-window` and `pr-gates`, turn auto-merge back on; until then the
maintainer merges and nobody arms by hand. On a head the queue already ejected for
failed checks it reads `AUTO_MERGE_OFF(ejected,k)`, which wakes nobody and never says
to re-arm, so a relaunch after an ejection cannot undo the ejection's own advice.

Hygiene: the watcher is a local tool and changes no required check, retry, shard or
timeout. Its fixtures stay in `scripts-test`'s `fixtures` step and add about a second.
No metric in `ci/metrics.yaml` measures how long a PR waits for its author after it
needs action; that metric is a follow-up. Revert if agents are woken for states they
cannot act on, or the pseudo-terminal fixture proves flaky on the Linux runners.
