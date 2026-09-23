---
id: 260923-223905
title: Permission decisions ride the tier gate's three choke points and the existing approval machinery
status: draft
created: 2026-09-23
spec: agent-permissions
superseded-by: null
---

# 260923-223905. Permission decisions ride the tier gate's three choke points and the existing approval machinery

## Status

Draft (extracted from spec: agent-permissions).

## Context

The new permission model (`260923-223904`) needs a gate and an Ask path. `enforceCapabilityTier` already has exactly three callers (`registry.invoke`, `authorizeCapability`, `mcp-tool-gate.ts`), pinned by `gate-bypass-scan.test.ts`. The approvals machinery already records an approval bound to the exact action and input (`260725-133221`), holds a claude-code tool call and resumes it in the same turn, and wakes an idle or non-claude session with a late verdict (`260909-123910`). A separate permission gate or a second approval system would add a fourth path and duplicate all of that.

## Decision

We will make the resolved permission a required input to `enforceCapabilityTier` (`permission: ResolvedPermission | null`, `null` for a no-area action), resolved fresh per call by one helper that reads the agent's manifest from the file and fails closed when the read throws. The gate's decision table becomes: no area keeps today's tier logic; Allowed runs; Ask lets `observe` through and sends everything else down the existing `ask()`/`consume()` flow, which until now only destructive calls reached; Blocked refuses with `permission_blocked`. Ask reuses the same approval record, in-session hold, late-verdict delivery and `ApprovalCard`; unattended origins skip the hold and rely on late-verdict delivery. `tier_ceiling` and `tool_group_disabled` refusals, `effectiveCeiling` and the standing-grant lookup are deleted. Every action with an area must declare `approvalDisplayFields`, because every such action can now raise a card.

## Consequences

### Positive

- Every surface is gated by construction; no fourth path appears, and the existing scan keeps pinning three callers.
- Nothing new is built for asking, and "the agent carries on after a yes" already works on every runtime.
- A caller that forgets the permission input does not compile.

### Negative

- `act` actions can now raise cards, so the presets must keep high-frequency verbs out of Ask.
- Conformance widens: every area action needs card display fields.
- The tier gate grows a second axis, which its tests must cover at all three choke points.
