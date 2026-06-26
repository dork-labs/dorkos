---
name: flow-drain
display-name: /flow — drain ready queue
description: Claim the top-ranked eligible issue and carry it to its review gate.
cron: '0 * * * *'
timezone: America/Los_Angeles
enabled: false
max-runtime: 2h
permissions: acceptEdits
---

Run one tick of the /flow autonomous loop in the reconciler registry order
**recovery → inbox/resume → dispatch** — the same order `@dorkos/flow` `runTick`
walks the `loops` config (priority 10 → 20 → 30). The continuous unattended runner
that calls `runTick` itself is the deferred P5 server build; this Pulse tick
follows the order in prose, re-deriving truth via the `linear-adapter` before each
pass acts. A higher-priority pass that claims an item wins same-item contention.

1. **Recovery** (`loops.recovery`, 10): via the `linear-adapter`, re-adopt any
   orphaned `agent/claimed` + started + not-`agent/needs-input` work — re-attach
   its worktree at HEAD and resume rather than re-claim. (Typed `recovery`
   reconciler + `FlowRun` land in P3.)
2. **Inbox/resume** (`loops.inbox`, 20): via the `linear-adapter`, poll the inbox
   for replies on `agent/needs-input` items; on a genuine non-agent reply,
   re-attach the worktree and resume the parked run. (Typed `inbox` reconciler
   lands in P4.)
3. **Dispatch** (`loops.dispatch`, 30): via the `linear-adapter`, fetch eligible
   work and rank it (dispatch ladder, §4); claim the top issue (durable label +
   state), provision its worktree, and carry it through the stages to its gate —
   uncertainty-gated involvement (§5).
4. Stop at the human-review gate or on a genuine question (needs-input).
