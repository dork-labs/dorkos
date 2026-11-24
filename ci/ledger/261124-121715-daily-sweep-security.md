---
id: 261124-121715
title: Security gets the daily sweep's list of merges that touched a security path, for its batch review
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.daily-sweep.sweep
prs: []
ratchet-release: []
field-changes: []
---

Dorian, Nov 24 (DOR-5120): Security gets the same once-a-day role as QA and the designer. It reviews
the merges since the last release that touched a security-sensitive area, and fixes forward with a
PR or a private Linear issue.

The daily sweep issue gains a "Security" section. It uses the gate's own list, not a new one: main's
`SECURITY_PATH_PATTERN` in `security-gate.yml`, matched by `touchesSecurity()` in
`.github/scripts/security-gate.mjs` on both sides of a rename (the same call `security-paths-check.mjs`
and `open-pr.sh` make). A PR on the deep-review list (`SECURITY_DEEP_PATH_PATTERN`, or a workflow or
gate file, as `security-verdict.mjs` decides) is marked P0. An unreadable or unclassifiable PR is
listed too. The issue carries PR numbers, titles, authors and paths only; findings stay private.
Nothing here gates a merge; the `security-review` check is unchanged.

First dry run (Nov 24, since v0.141.0): 65 merged PRs, 47 for Security (29 P0), 7 for design, 3 for
QA, 18 for none. Most of the 47 are CI, workflow and server-route changes, which the gate's list
covers on purpose.

Target: every PR on the Security list is ticked, or has a fix PR or a private issue, within two days of
its sweep. Evaluate: Dec 1, by reading the sweep issues and asking Security whether the list is the
right size.

Revert (or ask Security to narrow its own list) if the list is long enough that Security stops reading it.
