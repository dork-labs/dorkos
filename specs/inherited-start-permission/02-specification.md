---
slug: inherited-start-permission
id: 261004-234001
created: 2026-10-04
status: specified
linearIssue: DOR-2714
---

# Specification: a chat starts chats at its own level or lower

## 1. The rule

A chat started with `session_start` may run at any permission mode up to and
including the **calling chat's own live mode**, never higher. The ceiling is read by
the server from the caller, never from the tool's input. Leaving `permissionMode`
out means "the same as the caller". A request above the ceiling is refused.

## 2. Definitions

- **Level** = the runtime permission mode, as its runtime's descriptor declares it
  (`asks`, `reach`). The MCP tier gate is per agent and the new chat runs as the
  same agent, so that axis is inherited already and is not touched.
- **Not above** (`isNoLooserThan(ceiling, candidate)`, new, in
  `packages/shared/src/permission-semantics.ts`): the candidate asks at least as
  often AND reaches no further. Same `ASKS_RANK` / `REACH_RANK` as `isTightening`.
  Identity is "not above". Works across runtimes because it reads descriptors.
- **Ceiling**, in this order:
  1. In a chat: the live `AgentSession.permissionMode` of the calling chat, read at
     CALL time (it already reflects a scheduled run, a room turn, a person's
     lowering, and a live PATCH).
  2. In a chat whose live session object is missing: the stored settings row of the
     calling chat (`runtimeRegistry.getSessionSettings`).
  3. Neither known, or an id the caller's runtime does not declare: the caller
     runtime's declared default mode (asks about everything). Fails closed.
  4. No chat at all (external `/mcp`, agent token only): `acceptEdits` on
     claude-code, today's limit. There is no chat level to inherit.

## 3. Server changes

### 3.1 Caller resolution (`mcp-tools/index.ts`, `mcp-tools/types.ts`)

- `SessionStartCallerResolver` returns `{ agentPath, sessionId?, permissionMode?,
runtime? }`. The in-chat closure fills `permissionMode` from `session.permissionMode`
  and `runtime: 'claude-code'`, at call time.
- `McpToolSession` gains `permissionMode?: string` with a doc saying it is the live
  mode and must be read at call time. The factory already receives the live
  `AgentSession` (`launch-resolver.ts:698`), so no copy is made.
- The external `/mcp` resolver is unchanged: it can never produce `sessionId` or
  `permissionMode`. No header, argument or token field may supply either.

### 3.2 `session_start` handler (`mcp-tools/session-tools.ts`)

- Drop the schema `transform` that clamps `bypassPermissions`, and stop importing
  `clampSchedulePermissionMode` here (it stays for schedules).
- After the runtime is resolved and before anything is written, compute:
  - `ceiling` (section 2),
  - the target runtime's declared modes,
  - `granted`:
    - requested mode given: refuse `UNKNOWN_PERMISSION_MODE` if the target runtime
      does not declare it; refuse `ABOVE_YOUR_LEVEL` if not `isNoLooserThan`.
      Message names both levels in plain words, e.g. "This chat runs at Accept
      edits, so it cannot start a chat at Bypass permissions. Ask for Accept edits
      or lower."
    - requested mode absent: the caller's mode id when the target runtime declares
      it and it is not above; else the target runtime's default mode when not
      above; else refuse `NO_MODE_FITS` asking for an explicit mode.
  - when `granted` needs the Full autonomy consent (`needsConsentRitual`) and
    `hasStandingAutonomyAck()` is false: refuse `AUTONOMY_ACK_REQUIRED`.
- Always write `granted` to the settings row (never leave it NULL), so the stated
  level is exactly what the chat runs with.
- The result gains `permission: { mode, label, callerMode, sameAsCaller }`
  (`callerMode` null when there was no chat). The Activity event metadata gains
  `permissionMode`.
- Tool description and the `permissionMode` field description state the rule in
  one sentence: "The session runs at your own permission level unless you ask for a
  lower one; a higher one is refused."
- The module doc's "No trust stop of the operator's" bullet is rewritten to state
  the ceiling.
- `turn-origin.ts`'s `agent-launch` doc is updated: still seeds no operator stop;
  its power is the inherited, ceiling-checked mode.

### 3.3 Who started it, at what level

- `session_started_by` gains nullable `permission_mode` and `starter_permission_mode`
  (drizzle migration). `reserveFromChat` takes both and writes them. Rows written
  before this change keep NULLs.
- Wire `SessionStartedBySchema` chat variant gains
  `permission: { mode: string; sameAsStarter: boolean } | null`.
- Lowering the starter later changes nothing in the started chat (no cascade): the
  record is the level granted at start, and the started chat's own mode is its own.

## 4. Client

`StartedByLine` adds a second short line under "Started from <chat>", when
`permission` is present, using the session runtime's existing mode/stop labels:

- same: "Full autonomy, same as the chat that started it."
- lower: "Accept edits, lower than the chat that started it."

Copy follows `writing-app-copy` (≤15 words per block). Update the Dev Playground
showcase if `StartedByLine` has one.

## 5. Docs, ADR, changelog

- The docs page that documents `session_start` / agent-started sessions states the
  rule in one plain sentence.
- ADR: "A started chat inherits its starter's live permission level as a ceiling;
  no cascade on later lowering; a chat-less caller keeps acceptEdits."
- Changelog fragment in `changelog/unreleased/`.

## 6. Security properties the review must try to break

1. The ceiling never comes from tool input, a header or a token claim.
2. A lowered starter (live PATCH down) cannot start above its new level.
3. A scheduled or room turn running lower than its stored row cannot use the row.
4. A chain cannot climb: B started at X cannot start C above X.
5. The external `/mcp` server cannot exceed `acceptEdits`, with any token.
6. No other surface (capability registry, `dorkos call`, HTTP, extension
   `startWork` / `ctx.sessions.start`) reaches this path with a raised level.
7. Unknown or retired mode ids fail closed.
8. Full autonomy still needs the person's standing acknowledgement.
9. A refused start leaves no settings row and no reservation (existing invariant).

## 7. Tests (must fail on today's code where marked ✱)

- ✱ Caller at `bypassPermissions`, request `bypassPermissions` → granted.
- ✱ Caller at `bypassPermissions`, no request → granted `bypassPermissions`.
- Caller at `acceptEdits`, request `bypassPermissions` → refused `ABOVE_YOUR_LEVEL`
  (today: silently lowered — ✱ for the code).
- Caller at `acceptEdits`, request `plan` / `default` → granted.
- Chain: caller whose live mode is `acceptEdits` (row says `bypassPermissions`) → bypass
  refused (live beats row).
- Live mode unknown id → ceiling is the default mode.
- External caller → bypass refused, acceptEdits granted.
- Codex target: descriptors compared, not ids.
- No standing ack → Full refused `AUTONOMY_ACK_REQUIRED`.
- Result carries `permission`; `session_started_by` row carries both modes; the
  overlay and wire include `permission`; `StartedByLine` renders both copies.
- `isNoLooserThan` unit tests in shared.

## 8. Verification

`pnpm verify`; targeted vitest for every touched test file; the real app: start a
chat from a chat at Full autonomy and screenshot the started chat's first lines.
