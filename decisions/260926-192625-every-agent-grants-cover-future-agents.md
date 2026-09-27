---
id: 260926-192625
title: An owner may give every agent, including agents added later, access to one connection
status: accepted
created: 2026-09-26
spec: connections-one-list
superseded-by: null
amends: null
provenance: { tracker: linear, issue: DOR-2420 }
---

# 260926-192625. An owner may give every agent, including agents added later, access to one connection

## Status

Accepted (DOR-2420). It widens the authorization key in `specs/white-label-connections/02-specification.md` §3 from `(owner, agentId or operator actor, connectionId, operationRevisionId)` to also accept an owner-wide subject. ADR 260905-205123 stands unchanged: every call still goes through one authorization service and every grant still names immutable reviewed revisions.

## Context

Grants were keyed to one named agent on purpose, so no agent ever gained access the owner did not hand it by name. The Connections redesign (`specs/connections-one-list/design-decisions.md` §4) adds a second answer to "Who can use it?": **Every agent (including agents you add later)**. People who trust all their agents should not re-grant Gmail each time they add one. That is the biggest yes an owner can give, so it is a new kind of grant with its own guardrails, not a loop over today's agents.

## Decision

We add a third grant subject, `every_agent`, to `connection_operation_grants`: subject id `every_agent`, `agent_id` null. It lives in the same table as named-agent and session grants, so every existing connection-wide revocation covers it with no new code path. SQLite stores the subject as plain text, so no migration is needed.

**What it covers.** Exactly the reviewed operation revisions it was created with, like any grant. A new, re-versioned or reclassified operation is a new revision and stays off until the owner reviews it; an operation the provider cannot prove read-only is still classified destructive (Composio's `classify`), and the call still has to match its execution capability. It covers every agent the connection's owner has, including system agents such as DorkBot, because they are agents. There is no per-agent exclusion: to leave one agent out, the owner picks "Only agents I pick".

**Resolution order** (`ConnectorExecutionAuthorizationService.hasGrant`, mirrored by the runtime access list):

1. Connection state first, unchanged: paused, disconnected, not reconciled or not executable denies everything.
2. A session override for the connection decides alone. `detached`, another agent's override, or one awaiting reconciliation denies. `attached` allows only that session's own grants. An every-agent grant never widens a session the owner scoped by hand.
3. With no override, a named-agent grant **or** an every-agent grant for the exact revision allows. The two add up; neither narrows the other.

**Who can create it.** The owner, through the same reviewed flow as named-agent grants: `POST /api/connectors/reconciliation/apply` takes an optional `everyAgent.operationRevisionIds`, checked against the same complete, unexpired, owner-bound preview. That route refuses callers that present an agent identity, an approval token, an API key or a foreign origin, and with login on it requires the signed-in owner's session cookie. Management reviews and agent requests only ever write named-agent rows; no agent tool reaches this route. What that does and does not prove is under Negative.

**Turning it off needs no review.** `DELETE /api/connectors/connections/:id/every-agent` is owner-only like every grant change, but takes no preview, so it works while the service is unavailable or its configuration changed. Moving a provider instance to a DorkOS account ends its every-agent grants for good, so they cannot come back if it moves back.

**Lifecycle.** Disconnecting or removing the connection revokes it, because those paths revoke by connection. Removing an agent never touches it, because those paths revoke by `agent_id`, which it leaves null. That means removing one agent's access cannot take away what every agent has: a "remove access for X" review says, before approval, which actions X keeps through "every agent" (read live while the review is pending, since sharing can change after it was filed, and stored as seen at approval) and that stopping the sharing is how to take them away, and a disconnect review says every agent loses access. Revocation takes effect on the next call, including inside a running turn, because every call re-reads durable grants.

**Managed connections are excluded for now.** Hosted authority keys grants per named agent and has no owner-wide subject, so a connection through a DorkOS account refuses `everyAgent` (`every_agent_unavailable`), the preview says `everyAgent.available: false`, and every read ignores such a row even if one existed. Supporting it needs a `cloud-contract` change first.

**Disclosure.** `GET /api/connectors/every-agent-grants` answers "what will a new agent get?" for the whole owner, since the answer is the same for every agent and must be shown before the agent exists. Two places use it:

- The create-agent dialog (also the path a Marketplace agent package takes in the app) says it above Create, and holds Create until it knows: "Research Bot will get: Gmail (read). You can change this in Connections."
- Every other way an agent arrives — `POST /api/agents`, mesh registration and `mesh_register`, the `create_agent` tool, Marketplace installs through tools, discovery adoption — goes through the shared agent-created hook, which records one Activity entry when the agent inherits something: "Research Bot can use Gmail (Work Gmail, read), because it is shared with every agent", linking to Connections. Those paths create the agent first, so this is told after the fact, never before.

Each change to the grant itself is also an Activity entry: shared, widened, narrowed or stopped by the owner, naming the writer as honestly as DorkOS can ("Someone on this computer" with login off), and ended as a side effect of disconnecting the account or its provider moving to a DorkOS account, written by DorkOS with the reason. Connection summaries ("Every agent" instead of a count), disconnect impact and an agent's own connections list mark every-agent access, and per-turn account awareness counts it exactly as it counts a named-agent grant.

## Consequences

### Positive

- One choice gives every agent, present and future, the same exact reviewed access, and a new agent tells its owner what it inherits the moment it arrives.
- Revision pinning, the capability tier, approvals and immediate revocation apply unchanged, because the new subject goes through the same check.
- No per-agent behavior changes: a named-agent grant, a session override and agent removal behave exactly as before.

### Negative

- A new agent gets access without a separate yes. The guardrails are disclosure, not consent: the write warning when the grant is given, the inheritance line before Create in the dialog, and an Activity entry for every other arrival path, which comes after the agent exists.
- **With login off (the default), an agent with a shell can turn "every agent" on for itself and every other agent.** Login-off `resolveConnectorOperator` refuses a caller that announces itself, but a request that omits the agent and approval headers is indistinguishable from the app, exactly as for named-agent grants and every other owner write (the DOR-505 residual, `lib/caller-authority.ts`). No smaller mechanism closes it honestly: anything the app can fetch over loopback — a cookie, the local MCP token file — a same-user process can fetch too, and inventing such a marker would claim a distinction DorkOS cannot make. What holds: honest agents that follow their instructions cannot do it, and every change leaves an Activity entry saying who DorkOS thinks made it. Turning on login closes it: then only the signed-in owner's session cookie can write. Closing it with login off needs a human-only pairing step, which is a larger auth change.
- No exclusion list. An owner who wants all agents but one has to name them one by one.
- Connections through a DorkOS account cannot offer "Every agent" until the hosted contract learns an owner-wide subject.
