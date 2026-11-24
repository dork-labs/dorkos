---
id: 261124-132541
title: CI Steward computes lead time from merge to release (tracked.merged-to-released)
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.ci-steward.collect
prs: []
ratchet-release: []
field-changes: []
---

Hygiene: this changes the ruler, not the pipeline. No gate checks anything differently. DOR-5127.
Since Nov 23 releases go out once a day and a red main is fixed forward, which makes merge-to-release
the headline number. `tracked.merged-to-released` was in the catalogue but nothing computed it.

**What changed.** Each snapshot now records the day's merge commits (`merges`, from the merged-PR
search the collector already makes, so no extra request) and what each release published that day
shipped (`release_contents`: one `compare/<previous release>...<tag>` request per release, plus the
source of each `cherry-pick -x`, leaving out the release commit). The reader joins the two: per merged
PR, hours from its `mergedAt` to the first release that contains its merge commit, p50 and p90 over
a window. A sample sits at its release's publication, so a PR that waited is counted when it ships.
The verdict reads p50; the daily report's first panel shows both over the 7 days to its day.
`refreshOlderDays` fills the two fields in on older days (one merged-PR search and one compare per
release), each only when the day lacks it.

Cost: about one request a day while collecting, and two to four a day while refreshing older days,
on budget left over after collection. Revert if a collect run goes late because of it.
