---
id: 260903-091445
title: Every manifest field an agent can reach carries a written verdict, enforced in one place
status: accepted
created: 2026-09-03
spec: null
superseded-by: null
amends: null
---

# 260903-091445. Every manifest field an agent can reach carries a written verdict, enforced in one place

## Status

Accepted (DOR-1506).

## Context

`updateAgentManifest` is the agent-reachable write path into `.dork/agent.json`: `PATCH
/api/agents/current` and the `operator.update_agent` MCP tool (tier `act`, so nothing
asks a person) both land there. What it accepted was "whatever `UpdateAgentRequestSchema`
picks", minus three guards added one at a time as each field earned one — `account`
(billing), `enabledToolGroups.roomsManage` (the rooms grant, DOR-1611), and a direction
check on `tierCeiling` (DOR-486).

Three guards is not a policy, and the defect they leave is mechanical rather than
occasional: **a field added to that schema's `.pick(...)` list becomes agent-writable the
moment it exists**, silently, with no decision recorded anywhere. Nothing fails, nothing
is reviewed, and the field is on an agent's wire.

That is exactly how the reported defect arose. DOR-1497 made the four global
`agentContext.*` tool-context switches operator-only at the config seam, because an agent
could otherwise undo a narrowing a person had made to its own tool groups. But
`resolveToolConfig` reads `agent.<group> ?? globalConfig.<group>Tools`, so an explicit
**per-agent** value beats the global one — and the per-agent seam had no bar. A person
turned the switch off in Settings → Tools, and the agent restored its own context blocks
with one `curl` to `localhost`. `config-write-policy.ts` said so in its own module doc
and named this ticket as the fix.

Two other fields were writable for the same non-reason: `namespace`, which decides which
other agents this one can reach, and `behavior.responseMode`, which decides whether the
agent speaks in a room without being asked.

## Decision

**One classification table over the whole agent-reachable manifest wire, enforced once
inside `updateAgentManifest`.**

`apps/server/src/services/core/operator/agent-write-policy.ts` gives every leaf of
`UpdateAgentRequestSchema` and `UpdateAgentConventionsSchema` one of three verdicts:

- `operator-only` — refused on this seam; the person sets it on `PATCH
/api/mesh/agents/:id`. Nine leaves: `name`, `namespace`, `behavior.*`, `account`, and
  all five `enabledToolGroups` keys.
- `agent-writable` — a preference an agent may set for itself.
- `tighten-only` — `tierCeiling` alone: the verdict is a direction, so the comparison
  against what is on disk stays in `updateAgentManifest`.

Four properties make it a policy rather than a longer list of guards:

1. **A drift guard fails the build on an unclassified field**, in both directions
   (`__tests__/agent-write-policy.test.ts`). Widening either schema now forces a
   decision. This is the whole point — it closes the generator, not just the instance.
2. **The check runs first**, before the schema parse and before the manifest is read.
   Who may write a field cannot be contingent on the rest of the patch being well-formed
   (`{"roomsManage": null}` fails a boolean schema, and answering with a type error sends
   a model back to the same door), nor on which agent lives at the path.
3. **Refuse the whole patch, never strip the field.** A caller told nothing reports the
   change as done — the DOR-1253 shape. Naming a refused field at any value, or any
   object above it, refuses everything.

   **Including an object whose keys DorkOS does not recognise**, which adversarial review
   found this missing. The walk emits leaves and the matcher compares by
   equality/ancestor/descendant, so `{enabledToolGroups:{}}` was caught and
   `{enabledToolGroups:{zzz:1}}` was not — while the write replaces the object either
   way. Measured before the fix: 200, `{}` on disk, a person's two disabled groups and
   their `roomsManage` grant gone. `{behavior:{zzz:1}}` was sharper, because
   `AgentBehaviorSchema` defaults `responseMode` and the replacement re-armed `always`.
   So naming an object above a guarded leaf counts as naming every leaf under it unless
   every key it carries is classified. Scoped to this seam rather than the shared walk:
   `applyConfigPatch` deep-merges, so the same gap writes nothing there, and making the
   walk emit ancestors for everybody would break the honesty rule it exists to keep
   (DOR-1044).

4. **The refusal is worded per stake**, and says where the setting actually lives. A
   refusal that overstates what a setting does is a lie a model then repeats (DOR-1044),
   so the tool-group sentence says these decide what the agent is TOLD about — the tools
   stay registered either way.

The matcher both tables share (`guarded-paths.ts`) was extracted from
`config-write-policy.ts` unchanged rather than copied: a walk this subtle is how one copy
quietly stops covering part of its table (DOR-1113).

**The cockpit moved, rather than the verdict bending to it.** The profile's Tools page
wrote the four documentation keys through the agent self-edit route. It now writes all
five through `PATCH /api/mesh/agents/:id`, the same split its rooms-management grant and
tier-ceiling controls already used.

## Consequences

**What this closes.** Every sanctioned agent surface. The HTTP self-edit route and the
`update_agent` MCP tool are the two ways DorkOS itself writes a manifest on an agent's
behalf, and both go through one table now. An agent can no longer restore its own tool
context, move itself into a namespace it was not put in, rename itself, vote itself the
floor in every room, or repoint its own billing.

**What it does not close, stated plainly.** With local login off, the server cannot tell
the person in the cockpit from any process running as the same user — the `local-trust`
residual `contributing/agent-operator-surface.md` documents for every operator-only
effect on this machine. An agent with Bash can edit `.dork/agent.json` directly, and no
route guard can reach that. **The remedy is turning login on.** Do not describe these
fields as agent-proof; describe them as refused on every surface DorkOS controls.

**One field is gated by approval rather than by identity, and that is deliberate.**
NOPE.md (`nopeContent`, `conventions.nope`) stays `agent-writable` in this table:
`operator.update_agent` refuses it and points at `operator.update_agent_boundaries`, a
`destructive` capability that puts a card in front of a person (DOR-1698), while the
cockpit's own Boundaries page writes it through this route. Making it `operator-only`
here would break the person's editor to re-refuse a tool that already says no.

**`runtime` and `model`/`effort` were considered and left writable**, with the reasoning
written into the table. They grant no capability and remove no approval; the money
question beside them is `account`, which is refused, and the capability question is
`tierCeiling`, which is direction-checked. `runtime` is also the one operator-only
candidate the person's own Runs-on popover writes through this seam.

**Two error shapes changed.** `AgentUpdateErrorCode` lost `IMMUTABLE_NAME`: a slug rename
is now refused as `OPERATOR_ONLY` with a 403 rather than a 400, because the slug is not
immutable everywhere — a person renames an agent on the operator route. The refusal
sentence still points at `displayName`.
