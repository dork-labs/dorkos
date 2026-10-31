---
id: 261030-152000
title: Security gate passes on a security-reviewed label newer than the head while no App is set
kind: hygiene
status: proposed
actor: agent
gates: [wf.security-gate.security-gate]
prs: []
ratchet-release: []
field-changes: []
---

The Security App is shelved, so `SECURITY_APPROVAL_BOT_USER_ID` stays `'0'` and the
gate is red on every security-path PR. It can never be made required that way.
While the id is `'0'`, a security-path PR now passes when its newest
`security-reviewed` event is from a person and newer than the head's last push. A new
push voids it, and so does `hold`. Any real bot id runs App mode exactly as before.
Garbage or a missing id refuses. The job summary names the mode.

GitHub keeps no `synchronize` event to read back, so the push time comes from the
repository activity feed, and a later force push on the PR's timeline. A head not
in the feed refuses, including a fork's. The decision is one import-free module,
`.github/scripts/security-label-at-head.mjs`, which marketplace shares.

The workflow gains `labeled` and `unlabeled`, so a label change reruns the verifier.
No required check, retry, shard or timeout changes: the gate stays not required
until a separate toggle by Dorian. Hygiene because it is not required, so no metric
in `ci/metrics.yaml` can move yet. Revert if the hosted run can't read the timeline
or the activity feed with its read-only token: it then refuses every security path,
the same red as today.
