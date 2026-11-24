---
id: 261124-210558
title: the time-wrap signal tests wait for the START line instead of a blind 400 ms
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

`packages/ci-steward/src/__tests__/local.test.ts` slept 400 ms before signalling the wrapped shell,
guessing how long the shell takes to boot. It now waits for the wrap's START line, then 50 ms for the
two trap lines after it. The file went from 5.8 s to 2.3 s locally, and a slow shell no longer races
the signal. Only a test changed, not the wrap or any gate, so nothing in the pipeline's metrics should
move. Revert if the signal cases start failing because the traps were not set yet.
