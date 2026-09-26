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

**Who can create it.** Only the owner, through the same reviewed flow as named-agent grants: `POST /api/connectors/reconciliation/apply` takes an optional `everyAgent.operationRevisionIds`, checked against the same complete, unexpired, owner-bound preview. That route already refuses agents, approval tokens, programs and foreign origins. Management reviews and agent requests only ever write named-agent rows, so nothing an agent can call creates or widens an every-agent grant.

**Lifecycle.** Disconnecting or removing the connection revokes it, because those paths revoke by connection. Removing an agent never touches it, because those paths revoke by `agent_id`, which it leaves null. Revocation takes effect on the next call, including inside a running turn, because every call re-reads durable grants.

**Managed connections are excluded for now.** Hosted authority keys grants per named agent and has no owner-wide subject, so a connection through a DorkOS account refuses `everyAgent` (`every_agent_unavailable`), the preview says `everyAgent.available: false`, and every read ignores such a row even if one existed. Supporting it needs a `cloud-contract` change first.

**Disclosure.** `GET /api/connectors/every-agent-grants` answers "what will a new agent get?" for the whole owner, since the answer is the same for every agent and must be shown before the agent exists. Agent creation and agent-package installs show it: "Research Bot will get: Gmail (read). Change." Connection summaries, disconnect impact and an agent's own connections list mark every-agent access, and per-turn account awareness counts it exactly as it counts a named-agent grant.

## Consequences

### Positive

- One choice gives every agent, present and future, the same exact reviewed access, and a new agent tells its owner what it inherits the moment it arrives.
- Revision pinning, the capability tier, approvals and immediate revocation apply unchanged, because the new subject goes through the same check.
- No per-agent behavior changes: a named-agent grant, a session override and agent removal behave exactly as before.

### Negative

- A new agent gets access without a separate yes. The guardrails are disclosure, not consent: the write warning when the grant is given and the inheritance line when an agent arrives.
- No exclusion list. An owner who wants all agents but one has to name them one by one.
- Connections through a DorkOS account cannot offer "Every agent" until the hosted contract learns an owner-wide subject.
