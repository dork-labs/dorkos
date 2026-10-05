---
id: 261004-235818
title: A started chat inherits its starter's live permission level as a ceiling
status: accepted
created: 2026-10-04
spec: inherited-start-permission
superseded-by: null
amends: null
---

# 261004-235818. A started chat inherits its starter's live permission level as a ceiling

## Status

Accepted (implemented with `inherited-start-permission`, DOR-2714).

## Context

`session_start` lowered `bypassPermissions` to `acceptEdits` for every caller, the rule an agent-proposed schedule gets. A coordinator running at Full autonomy therefore got builders that stopped to ask, and a request for Full autonomy was silently lowered rather than answered. The operator's rule (2026-10-04): a chat may start chats at its own level or lower, never higher.

The per-chat axis is the runtime permission mode. The MCP tier gate is per agent, and a started chat runs as the same agent, so that axis is inherited already. A chat's level is its LIVE `AgentSession.permissionMode`: that is what its turn runs with, and it already reflects a scheduled run, a room turn, a person lowering it and a live PATCH. The stored settings row can disagree with the running turn.

## Decision

- **The ceiling is the calling chat's live mode, read by the server at call time** through the in-session resolver closure. Its stored row is the fallback when the live object has no mode; the caller runtime's declared default is the fallback after that, and an id the runtime does not declare falls there too (fail closed). Nothing in the tool input, a header or a token can supply or raise it.
- **A caller with no chat (the external `/mcp` server, an agent token) is held to `acceptEdits`**, today's limit. It has no chat level to inherit.
- **Compared by declared semantics, never ids** (`isNoLooserThan` in `@dorkos/shared/permission-semantics`): a mode is not above the ceiling when it asks at least as often and reaches no further. A read-only mode is judged on reach alone, because it never asks only because it has nothing to ask about. This is what makes the rule hold across runtimes: Claude's and Codex's `acceptEdits` share an id, not a level.
- **Leaving `permissionMode` out means "the same as me"**, where the target runtime declares that id and it fits; else the target's default when it fits; else the start is refused asking for an explicit mode.
- **A request above the ceiling is refused** (`ABOVE_YOUR_LEVEL`), naming both levels. It is never quietly lowered.
- **Full autonomy still needs the person's standing acknowledgement** (`hasStandingAutonomyAck`), checked on the granted mode.
- **The granted mode is always written to the settings row**, so the stated level is exactly the running level. The start records the granted mode, the starter's mode and whether they were one level (`session_started_by`), and the new chat says so under "Started from".
- **No cascade.** Lowering the starter later changes nothing in chats it already started. The record is the level granted at start; the started chat's own mode is its own.

## Consequences

### Positive

- A Full-autonomy coordinator gets Full-autonomy builders without asking, which is the point of the ticket. It widens nothing: the chat could already do that work itself at that level.
- A chain cannot climb: each link is held to the live level of the one before it.
- The agent is told the truth at once instead of finding out its builder asks.

### Negative

- A chat started at Full autonomy keeps it after its starter is lowered. A person lowers the started chat directly if they want that.
- A Claude chat below Full autonomy cannot start a Codex chat at Codex's middle stop, because that stop never asks. It gets Codex's read-only default instead, or asks the person to start it.
