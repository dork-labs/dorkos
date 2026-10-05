---
slug: inherited-start-permission
id: 261004-234001
created: 2026-10-04
status: ideation
linearIssue: DOR-2714
---

# A chat can start chats at its own level or lower, never higher

## Intent

Dorian, #dorkos 2026-10-04: "A chat should be able to create additional chats with
the same, or lower, permissions that it has. It can't create them with higher, but
it can create them with the same level."

Today `session_start` lowers `bypassPermissions` to `acceptEdits` for every caller,
so a coordinator running at Full autonomy gets builders that stop and ask. The new
rule replaces that blanket clamp with a ceiling: the calling chat's own level.

## Sources

- DOR-2714 (the rule, the done-when, the governance note).
- `apps/server/src/services/runtimes/claude-code/mcp-tools/session-tools.ts` — the tool.
- `apps/server/src/services/runtimes/claude-code/mcp-tools/index.ts:251` — the in-chat
  caller resolver (server-bound closure; the model cannot name a different chat).
- `apps/server/src/services/core/external-mcp/session-tools.ts` — the external `/mcp`
  surface: an agent token, never a chat.
- `packages/shared/src/permission-semantics.ts` — `isTightening` / `ASKS_RANK` /
  `REACH_RANK`, the existing cross-runtime "tighter or looser" rule.
- `apps/server/src/services/runtimes/claude-code/messaging/launch-resolver.ts:625` — a
  turn runs with the live `AgentSession.permissionMode`.
- `apps/server/src/services/core/approvals/autonomy-consent.ts` — the Full autonomy
  acknowledgement (`hasStandingAutonomyAck`).

## Codebase findings

1. **What "level" means.** The MCP tier gate (observe/act/destructive, "Always allow")
   is keyed by AGENT, not chat (`capabilities/permission-enforcement.ts`), and a
   started chat always runs as the calling agent. So that axis is already inherited
   exactly. The only per-chat axis is the runtime **permission mode**. "Trust
   settings" in the issue are the operator's configured trust stop, which the
   `agent-launch` origin never seeds (`turn-origin.ts`): that stays — the ceiling
   replaces it.
2. **Where the true level lives.** The live `AgentSession.permissionMode` is what the
   calling turn runs with (`launch-resolver.ts` reads it into `sdkOptions`), and a
   live PATCH updates it. It already reflects a scheduled run's mode, a room turn's
   mode and any lowering by a person. The stored settings row can disagree with the
   running turn (a warm sticky session ignores a later `ensureSession` mode), so the
   row is the fallback, never the first source.
3. **Who can call.** Only claude-code chats carry the in-chat tool. Codex and
   OpenCode do not. The external `/mcp` server can call it with an agent token but has
   no chat. It is not a capability (no `dorkos call`) and has no HTTP route.
4. **Comparing across runtimes.** Modes are runtime-declared descriptors with `asks`
   and `reach`. `isTightening` already orders them. A mode is "not above" the ceiling
   when it asks at least as often AND reaches no further.

## Assumptions

- The ceiling is the caller's live mode at the moment of the call.
- A caller with no chat (external `/mcp`) has no level to inherit, so it keeps
  today's ceiling: `acceptEdits`.
- Lowering a starter later does not lower chats it already started (no cascade).
- Leaving `permissionMode` out means "same as me", where the target runtime offers
  that mode. That is the point of the ticket: a Full coordinator gets Full builders
  without having to ask.

## Trade-offs

- **Refuse vs lower a request above the ceiling.** Today's clamp lowers silently.
  The ticket's done-when says "higher refused". Refusing tells the coordinator the
  truth at once; lowering hides it. Chosen: refuse, naming the caller's level.
- **Inherit by default vs runtime default.** Inheriting is what makes the rule useful.
  It does not widen anything: the chat could already start a chat and do the work
  itself at that level.
- **Live mode vs stored row.** Live is the truth of what the caller can do now; the row
  can be higher than the running turn. Chosen: live first, row as fallback, unknown
  mode fails closed.

## Out of scope

- An owner-wide opt-in toggle (explicitly dropped by the issue).
- DOR-2712 (wrong id returned, runtime not saved): separate fix in the same file.
- An agent with a shell calling `PATCH /api/sessions/:id` on itself — the existing
  DOR-505 residual; not reachable through this tool.

## Recommended direction

Specify it as one server change in `session-tools.ts` (ceiling + refusal + inherit
default + result field + consent check), one store/wire change (record the granted
level and whether it matched the starter), and one line of client copy.

## Next step

SPECIFY.
