# Stored-model launch reconciliation implementation

**Issue** DOR-1692

**First submission** `codex/required-room-recovery-birth` in the isolated worktree with the same slug

**Progress** 1 of 14 tasks complete

The first submission includes the allocation migration, the protected first-write seam, and its use by the existing required room recovery flow. The mover reads settings before writing, then publishes the settings, lifecycle, requirement and seat binding in one transaction. Canonical rekey preserves the owning lifecycle and rejects outstanding allocations. The settings, dispatch, and inference milestones below track the wider project.

## Task 1.1 — Durable allocation and inference lifecycle storage

Worker `/root/http_4152_review` added the allocation table, effective SQLite shape checks and the nullable lifecycle field. The coordinator reviewed all changed paths and the generated SQL under `REVIEW.md`. The table distinguishes person-owned locations, registered agents and named internal sources. Its constraints validate the stored shape. The later transaction task verifies source ownership against the records that actually minted a session.

The migration generator initially produced a table rebuild that selected the new column from the old table. The real SQLite setup failed on that query. The corrected additive migration leaves the existing table and partial index in place. All 42 targeted tests passed with one worker and zero retries. They exercised old-row preservation, raw SQLite constraint failures, persistent drafts, collisions and rollback. The database package typecheck and targeted ESLint passed.

Task 1.2 owns the transfer into the first metadata transaction. It needs the actual source at each writer and rekey seam.

## Task 1.2 — Verified transaction seam

Worker `/root/http_4152_review` implemented the synchronous writer seam. A standalone caller opens one transaction. An existing owner can join with a savepoint. The seam preserves the original insert and conflict expressions and consumes the allocation only after verifying the new row. It reads the source and allocation again before consumption. Restarted receipt delivery requires the exact persisted queue destination and sender.

The coordinator reviewed the source and ran the real SQLite suite. The first run exposed a test fixture that lacked required seat fields. After the fixture and restart provenance were corrected, all 43 cases passed. The server typecheck and targeted lint passed.

Task 1.2 is still in progress. Its remaining work covers the original metadata writers, source variants, caller context and canonical rekey.

### Required room recovery rekey

A canonical rename carries the current required session's recorded lifecycle into a missing destination in the existing transaction. An existing destination keeps its evidence and settings. Historical aliases retain the recovery requirement and carry no independent lifecycle proof. An inconsistent unconsumed allocation refuses the rename.

The coordinator reviewed the current owner and rekey paths and ran the three focused suites. All 45 cases passed, including the actual SQLite rollback and repeated native-owner rekey fixtures. Server typechecking and scoped lint passed.

Required room publication still needs the first settings writer. The seat mover writes settings before publishing the requirement, so publication alone cannot establish the new session's allocation. The rest of task 1.2 remains open.

### Native import and automatic resume

Native import and automatic resume run their original writes inside the birth transaction without a birth claim. A conflicting allocation remains unconsumed. Imports retain their runtime and account checks and roll back metadata if the native binding write fails. Resume still changes only its existing marker on a conflict.

The coordinator reviewed the original and moved transaction. All 146 registry tests passed with the eight new SQLite cases. Both server typechecks, scoped lint and the existing size rule passed. The remaining first writers and their authenticated caller context stay open under task 1.2.

### Settings and runtime binding

The first explicit settings write and runtime binding now use the same transaction for allocation transfer. The binding checks that the source is consistent with the real turn origin and the agent path when the source identifies an agent. Existing settings updates and runtime claims keep their original conflict rules.

All 161 registry tests passed. The added SQLite cases cover owner and source changes, explicit Plan and model choices through binding, legacy settings, and rollback when allocation consumption fails. Both server typechecks and scoped lint passed. Moving the binding statement into a private module lowered the measured file-size baseline from 564 to 556 lines.

The route and dispatcher still need to supply the verified source context. Required room recovery also needs source evidence at its early settings write. Task 1.2 remains open.

### Required room recovery settings

The replacement owner captures the exact destination and the earlier failed seat before reading settings. Publication rechecks the seat generation, agent, failed dispatch and owning handoff. One transaction reserves the destination, writes the settings and recovery reference, transfers the allocation and moves the seat. The mover carries the old marks before exposing the pending launch.

All 201 focused tests passed. They covered the runtime registry, durable recovery requirements, and both maintained room recovery suites. The new SQLite cases exercised changed ownership, a missing destination after settings, and a replay against a different destination. Both server typechecks and scoped lint passed. Other metadata writers and the remaining source callers stay open under task 1.2.

The publication branch also covers a refused final seat update through the real mover. It checks that the room retains its previous seat and that the attempted destination leaves no settings, allocation or requirement. A later admission can publish a different destination with the same carried settings and marks.

### Person mode and continuation holds

The person-mode marker and the three continuation-hold writes now check for a pending allocation inside the write transaction. A marker, hold or alias cannot establish that a chat is new. If an allocation exists and the writer lacks verified owner context, the write leaves the allocation available and keeps the existing warning and cache behavior. Existing chats keep their original marker and hold updates.

All 17 focused tests passed, including real SQLite rollback, the retained stranger cache after a refused write, and retry after a failed hold write. Both server typechecks and scoped lint passed. The route and dispatcher still need to supply verified context at their actual first writers. Task 1.2 remains open.
