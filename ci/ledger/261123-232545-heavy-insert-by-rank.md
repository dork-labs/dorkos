---
id: 261123-232545
title: An --insert with no position goes where its ticket ranks in the work order
kind: hygiene
status: proposed
actor: agent
gates: [wf.scripts-test.fixtures]
prs: []
ratchet-release: []
field-changes: []
---

DOR-5065. The order line (`scripts/heavy-run-lock.sh`, DOR-4209) put every
`--insert` with no position at the end, so coordinators moved labels by hand to
where their ticket's place in the work order said: about 20 hand moves on
2026-11-22 alone (`.temp/coord/heavy-order-notes.md`).

Now `--insert <label>` with no position asks `flow order --json` (Flow 0.100.0+)
once per command and puts a label naming a `DOR-` ticket in front of the first
line whose ticket ranks lower (no ticket or no rank counts as lowest; a release
row or a running line is never passed). Release rows (`rel-*`, `qa-gate-*`,
`qa-row*`) go first, behind release rows already there and whatever is running.
A label with no ticket, or a ticket flow does not rank, goes to the end with a
note. A real `flow order` pulls the whole backlog and took over two minutes on
2026-11-23, so the ranks are kept in the order folder for 30 minutes and
refreshed in the background; a command waits at most 10 s for a refresh,
outside the order lock, then uses ranks up to a day old or puts the label at
the end with a note. Flow missing, old, failing or slow never blocks the write. `--list` gains one rank column. The log
marks each placement `by rank: …` or `by hand: …`, so a person's moves can be
counted.

Hygiene rather than an experiment: no gate's pass or fail, duration or retries
change, and the number this is meant to move is not one the collector reads.
Stated so it can be checked by hand: hand moves per day, counted as
`heavy-order.log` rows whose detail starts `by hand:` with op `move`, in the
machine's order folder (`~/.dork/load-gate/`); baseline about 20 on 2026-11-22
(the coordinator's notes, before this log marked hand moves); target under 5 a
day on a typical day of the week of 2026-12-07, once Flow 0.100.0 is installed
here. Revert, or rethink the placement rule, if hand moves stay over 10 a day
then. The gate listed is the fixture job that runs
`scripts/test-heavy-run-lock.sh`, which gains the cases with a fake flow.
