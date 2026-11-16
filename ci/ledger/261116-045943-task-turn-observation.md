---
id: 261116-045943
title: Observe scheduled test turns before reading provenance
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.test-shard, wf.test.test]
prs: []
ratchet-release: []
field-changes: []
---

DOR-4521 repairs the failed task-provenance case in the completed e962 full
verification. The real scheduler had not called the test runtime within
vi.waitFor's implicit 1,000 ms. The case itself already allows 5,000 ms. Separate
bare and strict-Turbo single-file runs passed all three original cases; those
isolated passes do not replace the failed full gate.

Each fixture now owns a promise resolved inside its fake runtime's actual
sendMessage async generator, when the real scheduler consumes that stream.
runNow awaits that observation and checks exactly one send. The real scheduler,
TaskStore, SQLite row, turn options, outsider marks, teammate ceiling and own
proposer assertions remain. The existing outer test budget bounds the wait.
No polling retry, sleep, test/hook timeout, production code, required gate,
worker/shard setting or quality floor changes.

A disposable 1,500 ms delay before the real scheduler calls ensureSession and
sendMessage reproduces all three old polling assertion failures. The observer
passes all three with the same delay and original outer case budget. The delay
is then removed and the production file restored byte-for-byte. Separately
removing only the production outsider carried-mark producer must fail that
subject while teammate and own-proposer controls still pass; restore all three
green. These are offline fixture/real-scheduler proofs, not actual model runs.

This is test synchronization hygiene, not an aggregate speed or CI SLO claim.
The fresh ci-status used for the companion config repair still reports two
stale local exports and unavailable org-rule comparison; no floors are based
on incomplete collector data. Revert or revise if the observer can be satisfied
without its fixture's real turn consumption, provenance assertions stop finding
their subject, or scheduler/store cleanup leaks. Separate REVIEW.md review and
fresh immutable combined full verification remain required.
