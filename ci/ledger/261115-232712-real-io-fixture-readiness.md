---
id: 261115-232712
title: Wait for real I/O readiness in verification fixtures
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.test-shard]
prs: []
ratchet-release: []
field-changes: []
---

DOR-4494 repairs three real-I/O test fixtures without changing production.
The socket oracle waits for each server's actual connection delivery instead
of treating a client connect and one event-loop turn as an acceptance barrier.
The task watcher seeds its startup probe before watching and waits for the
existing ready/catch-up boundary before introducing the rejected install sibling
and the positive normal-task live event. Its 300 ms absence observation stays.

The room story retains both real merge-service calls and every clean refresh,
dirty hold, overlap, quiet person edit and named-person assertion. Ana's
unasserted extra turn is replaced by an actual audited Git fast-forward of her
fixture checkout before the second commit. Simply omitting that wake was tried
and correctly refused by the product's BEHIND_MAIN guard; no guard was changed.
The harness already had zero debounce, so no collection sleep was removed.

This is fixture hygiene, not an aggregate performance experiment. The original
full run had an owned-socket count of one instead of two and watcher/room test
timeouts; an unchanged isolated room story also failed once and passed once.
Local profiling observed 110 calls through the hardened Git runner in the
original story and 100 after replacing the extra turn with one real fast-forward. These are
fixture command counts, not an SLO or production-performance improvement.
Headroom remains finite. The 2026-11-14 collector reports stale local exports
and failed health, and supplies no reliable per-fixture baseline to claim here.

Negative controls disable actual HTTP socket retention, live task adds, the
room's actual fast-forward, and its dirty-state hold in turn. Existing positive
and negative assertions must fail for the broken mechanisms and pass when each
exact source is restored. Temporary profiling and mutants are not delivered.
Revert or repair if any control escapes the oracle, a native case is skipped,
or the complete real story no longer holds under its original 5000 ms budget.
No workflow, timeout, retry, shard, floor, quarantine or judge changes.
