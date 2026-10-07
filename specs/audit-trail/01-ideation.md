---
slug: audit-trail
number: 261006-225901
created: 2026-10-06
status: ideation
---

# Audit trail v1: every action recorded, readable by space members and agents

**Slug:** audit-trail
**Author:** Claude (IDEATE for Dorian Collier)
**Date:** 2026-10-06
**Linear:** DOR-2738

---

## 1) Intent

DorkOS is moving to "trusted by default": agents do routine work without asking first, and the safety net is a record anyone in the space can read and act on. That trade only holds if the record is complete before any gate is loosened (DOR-2739 comes after this). Today it is not: several real actions leave no line anywhere, the closest thing to a log is pruned at 30 days, nothing is tamper-evident, agents are named by their folder path, and there is no single "pause this agent" lever.

This spec makes one append-only, hash-chained log of actions the superset of what DorkOS records, wires the silent paths into it, gives people and agents a way to read it under one visibility rule, and adds the pause lever.

## 2) Settled decisions (operator, 2026-10-06; not reopened here)

- Agents are trusted professionals. The safety net is an audit trail anyone in the space can read, people and agents alike.
- Both people and agents can read every agent's chats: agent work transcripts and agent-to-agent DMs.
- A person's own private chats stay private: their DMs with people and their direct chats with agents. The actions an agent took during such a chat still show in the log.
- There are no spaces or roles yet. A local install is a one-person space and the owner sees everything. The visibility class (`space | participants | admins`, plus participants) is designed into the data now and enforced for agent readers now.
- Loop guards (cascade guard, turn budgets, relay ceilings) are out of scope.

## 3) What already exists (verified at `8b5b7b51b`)

- **Activity feed** (`activity_events`, `services/activity/activity-service.ts`): the closest thing to a log. Append-only by convention only, pruned at 30 days except the `permissions` category (`index.ts:1403`), keyed on agent path (`activity-actor.ts:77`). Agents read all of it through `activity_list`.
- **Connector usage ledger**: the one append-only-by-trigger pattern (`drizzle/0086_perfect_whiplash.sql:224-254`). We copy it.
- **One seam every turn passes through**: `runtimeRegistry.register()` already wraps every runtime in Proxies that intercept `sendMessage` (`core/keep-awake/hold-during-turn.ts`, `observability/trace-runtime.ts`). Interactive chats, room replies, scheduled runs and relay deliveries all go through it. This is where runtime tool calls get recorded and where a pause is enforced as a backstop, for all three runtimes at once.
- **One seam every new session passes through**: `RuntimeRegistry.persistSessionRuntime(sessionId, runtime, origin: TurnOrigin, agentPath)` with a required, exhaustive `TurnOrigin` (`session/origin/turn-origin.ts`). This is where a session's visibility class is born.
- **An ALS precedent**: `lib/dispatch-context.ts` carries a correlation id across a dispatch chain without threading parameters. An audit actor context can ride the same mechanism.

## 4) Shape of the answer

1. **Store and ids**: `audit_events` (append-only and chain-linked by SQLite triggers), one writer, stable account ids (agent mesh ULID; the owner gets an id even with login off), every Activity event teed in, `audit.verify`, longer Activity retention.
2. **Close the silent paths**: allowed hand-registered MCP tool calls (which also covers `mesh_deny`/`mesh_unregister`), unattributed registry `act` calls, config diffs, marketplace mutations, sign-ins and key/token lifecycle, room-merge attribution.
3. **Runtime tool calls**: one Proxy at `runtimeRegistry.register()` writes `runtime.tool_used` for Claude Code, Codex and OpenCode.
4. **Read side**: visibility class on sessions, `audit_query` / `audit_get` / `account_timeline` / `transcript_read`, HTTP routes, an "All actions" view on `/activity` and an Activity page on every agent profile, and the session-route leaks closed.
5. **Pause**: one "pause this agent everywhere" lever, reversible, any member, recorded.

## 5) Open questions resolved in the spec

- Owner id with login off: reuse the install id DorkOS already treats as the local owner for connectors (`index.ts:1152`, `ownerKind: 'local_install'`), linked to the Better Auth user id when an account is created. See spec §3.2.
- Activity as a "view": Activity stays a table in v1 and every row is teed into audit, so audit is the superset. Replacing the table with a projection is a follow-up (spec §3.5).
- Retention: audit rows are kept forever in v1 (the delete trigger forbids pruning). Activity's default rises from 30 to 365 days via a setting.
