---
id: 261109-054455
title: A Security label counts only when the Security account added it
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.security-gate.security-gate
  - wf.security-review-initialize.initialize
  - wf.security-review-initialize.merge-group
prs: []
ratchet-release: []
field-changes: []
---

## Why

In label-at-head mode, `security-reviewed` and `security-deep-reviewed` counted when any User account added them. Agents are getting their own GitHub machine account, which is also a User, so any agent could label its own PR through the gate. Security gets an account of its own instead (Security's spec, #dorkos, 2026-11-08).

## What changes

A Security label counts only when the actor of its newest `labeled` event, read from the timeline and compared by numeric `actor.id`, never the login, equals the repo variable `SECURITY_LABELLER_ID`. Otherwise the verdict fails with "label not applied by Security". The label must still be newer than the head's last push, as before. The variable reaches the scripts as `vars.SECURITY_LABELLER_ID` in `security-gate.yml` and in both jobs of `security-review-initialize.yml`. It fails closed when the variable is unset, empty, `0` or not a positive integer, or when the timeline cannot be read.

App mode (`SECURITY_APPROVAL_BOT_USER_ID`) is untouched: it trusts the App's status, never a label, and never reads the new variable.

## Hypothesis

`security-review: success` verdicts on a security-path PR whose newest Security label came from any account but Security's go from possible to 0 over the 14 days after merge. QA reads it by hand from the verdict job logs and the PR timelines; no collector metric covers it yet.

## Order

Merge only after Dorian has set `SECURITY_LABELLER_ID`. Without it every security-path PR fails closed.

## Not fixed here

The design-token rule guard (`scripts/design-tokens/rule-guard.ts`) reuses `labelNewerThanHead`, which still accepts any User. Its own header names this as the next step once agents have their own identities; it needs its own change.

Revert if the verdict cannot read `actor.id` from the timeline with its token: every security path then fails, the same red as an unset variable.
