---
id: 261122-215702
title: The committed order line lets the second label start while the machine is healthy
kind: hygiene
status: proposed
actor: agent
gates: [wf.scripts-test.fixtures]
prs: []
ratchet-release: []
field-changes: []
---

DOR-5073. The coordinator's own order script lets the SECOND label in line
start beside the top while the machine is healthy (Dorian's OK, 2026-11-22).
The committed order line (`scripts/lib/heavy-order.sh`, DOR-4209) let only the
top start, so the old script could not be retired without halving what the
lanes get done.

The rule now lives here, with every check and number the old script used:
swap used under 12288 MB, free memory at least 40%, swap growth at most 512 MB
since a reading 10 to 30 minutes old (the newest such sample, kept in
`heavy-swap-samples` in the order folder), the 5-minute load under 16, and at
least 50 GB of free disk. The numbers are the `local.heavy_second_*` keys in
`ci/config.yaml`, pinned to the script's fallbacks by `local.test.ts`. The top
still always may start, and the third line never does. A reading that cannot
be had, or a limit that is not a number, refuses the second.

This copies a rule already in use by hand, so no metric is meant to move.
Revert if two labelled runs at once push swap past 12 GB while both run.
