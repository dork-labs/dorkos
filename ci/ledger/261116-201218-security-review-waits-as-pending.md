---
id: 261116-201218
title: 'A PR head that is only waiting for Security shows security-review pending, not failure'
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.security-review-initialize.initialize
prs: [3865]
ratchet-release: []
field-changes: []
---

DOR-4459 follow-up. #3802 made the `security-gate` PR job pass with "Waiting for Security"
when a PR is only waiting, but main's `security-review` commit status still wrote `failure`
for the same states. So nearly every open PR showed a red ✗ that meant "not reviewed yet",
and people read it as a rejection.

`security-verdict.mjs` now writes `pending`, with the same description, when the gate's own
waiting rule (`awaitingReview` in `security-gate.mjs`, now exported) says an open PR is
waiting: no `security-reviewed` yet, `hold` on with no wrong Security label, or a P0 path
whose fresh `security-reviewed` still lacks `security-deep-reviewed`. The P0 test uses the deep
list only, so a workflow or judge-file edit missing only the deep label stays `failure`:
`security-gate`'s queue leg does not know those files need it and reads only the status.
Everything else stays `failure`: a stale label with no `hold`, a bot's label, a label with no
event, an unreadable push time, a stale deep label, a closed or merged PR, a base that is not
main, an error.

`pending` blocks like `failure`. `security-review` is not a ruleset-required context;
`should-arm-automerge.sh` refuses any bucket but `pass`, pending included. The merge-group
verdict on the group SHA is unchanged: `verdictForMergeGroup` still fails on anything but
`success`, and `security-gate`'s queue leg still refuses each waiting head from its labels.
No trigger, permission, path list or required check changed.

Revert if a PR merges, or arms, with `security-review` pending, or if a `merge_group` run
of either workflow passes a group it refused before.
