---
id: 261125-170411
title: The daily release reads "no hold issue" as no hold, not as unreadable
kind: incident-fix
status: proposed
actor: agent
gates: []
prs: []
hypothesis:
  metric: tracked.timed-slot-misses
  baseline: 1
  baseline_source: 'daily-release run at 15:39Z Nov 25 (the backstop did the 15:07 slot): REFUSE unreadable: release-hold issues, with no hold issue open'
  target: 0
  after_days: 7
ratchet-release: []
field-changes: []
---

#4372 added the rollback hold: an open issue labelled `release-hold` stops new cuts. Its lookup asked gh for the first
such issue with `--jq 'first | …'`; with none open the result is null, and gh prints nothing at all for a null
result, so the empty answer failed the shape check and was marked unreadable. Every daily run would refuse. The
fixtures missed it because the stub gh ran the filter through jq, which prints `null`.

The lookup now reads an empty answer from a call that succeeded as no hold, and the stub gh prints nothing for a null
result, as the real one does (several fixtures fail against the old script with the faithful stub). Revert if a hold
issue is ever ignored.
