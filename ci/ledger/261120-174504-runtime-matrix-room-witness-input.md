---
id: 261120-174504
title: Recheck the runtime matrix when the room witness changes
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.test-shard, wf.test.test]
prs: []
ratchet-release: []
field-changes: []
---

DOR-2724 lets a runtime capability cite an exact browser test. The server's
capability census reads the Rooms reply spec to confirm the cited cases still
exist. Include that single file in the server test inputs so a rename or
deletion reruns the census instead of reusing a cached pass.

The existing server inputs already include the server test witnesses and
the checked-in capability reports. No workflow, check name, timeout, shard
count, or test eligibility changes. Update this input if the cited spec moves.
