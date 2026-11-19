---
id: 261119-011400
title: label-at-head checks are timed by the PR's latest typecheck run, not the committer date
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

A security tightening with no metric to move (DOR-4706, Security Nov 18). The queue door's "is
Security's label at or after the head?" check timed the head by its committer date, which the
pusher sets. It now uses the later of that and the PR's latest `typecheck.yml` `pull_request` run
for the SHA on the PR's own branch, from this repo. Check suites were tried first and dropped: they
belong to the SHA repo-wide, so a side-branch push dates it early. The earliest run was dropped too:
a head that left and came back, or a reused or fork branch, dates it early. The local arm script
and the release range check change the same way. `typecheck.yml` gets a header saying it is that
clock. Revert or narrow it if a PR that Security labelled at its head is ever pulled for a stale
label.
