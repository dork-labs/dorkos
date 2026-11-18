---
id: 261118-130941
title: The heavy-run-lock test proves a nested call never queues by its output, not a 2s clock
kind: hygiene
status: proposed
actor: agent
gates: [wf.scripts-test.fixtures]
prs: []
ratchet-release: []
field-changes: []
---

`scripts/test-heavy-run-lock.sh` checked "a nested call does not wait on its
parent" with a fixed 2-second wall-clock bound. That bound measured starting
bash and perl twice, which a loaded Mac stretched to 5s, failing local
`test:scripts` on healthy code (DOR-2021, Nov 17). The property is now proven
by the output: a call that waited prints the queueing line, and the exact
output check already rejects it. The clock stays as a backstop at 10s, half
the test's 20s wait, so a real wait still reds both ways.

Test-only; the lock script itself is unchanged, and no gate, retry, shard,
required check, steward or judge changes. Nothing measurable should move.
Revert if a nested call that really queues ever passes the test (with nesting
detection removed, all three nested checks red today).
