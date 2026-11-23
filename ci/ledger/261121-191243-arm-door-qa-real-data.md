---
id: 261121-191243
title: the merge queue takes out a config or migration head queued without QA's real-data label after it
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.arm-door.door
prs: []
hypothesis:
  metric: 'tracked.qa-ungated-merges'
  baseline: 1
  baseline_source: "counted by hand on 2026-11-21 from #4096's file list and label events: it changes apps/server/src/services/core/config-migrations/ and packages/shared/src/config-schema/, QA's qa-real-data went on at 15:58:45Z and came off at 16:01:53Z, and it was added to the merge queue at 18:13:38Z with no label and no arm-record stamp, then merged at 18:40:17Z. arm-door kept it because Security's label and green CI were at the head. Window 2026-11-15..11-21: #4096 is the one case known (incident report, not a full recount of every merge); DOR-4904"
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

The arm script refuses a pull request that touches config or migration code unless QA's
`qa-real-data` label went on after its head: QA runs the real-data upgrade gate at that exact
head. arm-door, the merge queue's door for entries that skip the arm script, checked Security's
label and a verify proof but not QA's. #4096 was queued that way on 2026-11-21 and merged with a
QA failure nobody had explained.

The change: QA's rule moves into `scripts/qa-real-data.sh`, one file both callers run, so the
two can't drift apart. `needs` is the path rule (the path set, a connector upgrade ledger write
anywhere outside tests, a file GitHub sent no patch for, or the label already on the PR),
`fresh` is the label-time rule (strictly newer than the head), and `patches-jq` is the filter
that builds the per-file patches it reads. `scripts/arm-door.sh` calls it with the same head time
it uses for Security's label: the later of the committer date and the PR's latest `typecheck`
run for that head. A head that needs QA and has no current `qa-real-data` label, or only one
older than the head, is taken out (`no-qa-label`, `qa-label-older-than-head`). A label taken
off still has its event, so the current labels are read too: that is #4096's case.

The designer's sign-off gets the same treatment: `scripts/design-ok.sh` (`needs`, `fresh`) holds
the arm script's design rule (user-visible paths outside tests and the Dev Playground, or
`needs-design`; release PRs exempt), and arm-door pulls a head that needs it with no current
`design-ok` newer than the head (`no-design-ok`, `design-ok-older-than-head`). Its effect is not
part of this entry's hypothesis, which stays on QA's metric; a design miss would show in the
same arm-door verdict lines.

Because the arm script will read these files from main instead of a hash-pinned local copy,
`scripts/arm-door.sh`, `qa-real-data.sh`, `design-ok.sh` and `queue-repeat-guard.sh` join the
security path set (all three copies), so a change to any of them needs Security's label.

It still fails open like the rest of arm-door: labels, label events, patches or a title it cannot read
keep the entry with a warning, but never hide another gate's pull. The ruleset is unchanged.

The arm script reads the same file from main, the way it reads the verify-proof checker,
once this merges; until Security promotes that change, its local copy holds the identical rule.

Revert, or narrow it, if it takes out a pull request whose head did carry a fresh QA label (a
misread label time or file list) more than once in the window.
