---
id: 261116-043911
title: Keep cold config imports outside per-test setup
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.test-shard, wf.test.test]
prs: []
ratchet-release: []
field-changes: []
---

DOR-4519 repairs the resurfaced config slice of the parked DOR-2021 record.
The completed e962 full verification failed the first config case before its
request ran: the existing beforeEach exceeded its 10,000 ms budget. A separate original
phase trace reproduced that hook failure. Isolated original setup also passed
at 9.20 s; neither sample is an aggregate performance or CI SLO measurement.

Only cold module evaluation moves outside the timed fixture. A throwaway
DORK_HOME is initialized in the original order, then the config route and
HTTP listener declarations load. The bootstrap graph is discarded with
vi.resetModules, its owned directory is removed, and DORK_HOME is restored
exactly in nested finally blocks. No bootstrap request is sent and no router,
listener, config or sign-in-policy reference is retained for a real test.
Every existing per-test import, initialization, reset, environment-positive
reimport and assertion remains. The hook and case budgets remain unchanged.

The added isolation cases drive the real config and sign-in-policy modules
with a controlled declaration loader. They check initialized bootstrap state,
subsequent uninitialized state, caller-data preservation, directory cleanup,
an originally absent home and a rejected import. Removing the bootstrap reset
must expose the leaked real stores; restoring it must restore green. The full
147-case route fixture still exercises the environment and caller-policy bars.

This is fixture hygiene, with no production auth, permission or timing change.
The historical atomic/editor loops retain their 200/600 trial counts; they have
no new triggering failure in this slice. No retry, skip, shard, worker cap,
required check, quality floor, steward or judge changes. Fresh ci-status still
reports collector-health FAILED (two stale clone exports, plus unavailable org
rule comparison); no SLO claim is based on those numbers.

Revert or revise if bootstrap state or files leak, a caller's DORK_HOME is not
restored on failure, a retained module instance bypasses fresh fixture state,
or any existing config/auth/environment assertion stops detecting its subject.
Independent REVIEW.md review and a fresh immutable-head full pass remain
required; isolated green does not replace the failed integrated gate.
