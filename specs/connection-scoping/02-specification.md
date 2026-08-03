# Connection Scoping Backend — Specification

DOR-856 · M12 of the Language & IA program · server-side only (UI is DOR-857).

Source: `plans/language-ia-simplification.md` §Phase 3 design decisions items 3
(Moves 1+2), 5 (audited facts), 8 (stranger/group policy).

## Scope

Three independent-but-related backend changes to the Relay/Connectors seam:

1. Agent-level connector attachment, persisted, with a session-override ladder.
2. Creation-time uniqueness on `(adapterId, chatId)` — one chat routes to
   exactly one agent — plus move semantics and an `enabled` fix in
   `BindingStore.resolve()`.
3. A durable "unclaimed chat" claim feed for inbound messages with no binding.

No client code changes. `pnpm docs:export-api` regenerates the OpenAPI spec
from the new/changed Zod schemas as part of this change.

---

## Part 1 — Agent-level connector attachment

### Current state (as audited)

`SessionConnectorService` (`apps/server/src/services/connectors/session-exposure.ts`)
holds attachments in `Map<sessionId, Map<accountId, AttachedAccount>>` —
in-memory, gone on restart. Attach happens via `POST
/api/sessions/:id/connectors/:accountId` or the `connector_attach_account` MCP
tool (`connector-capabilities.ts`); both ultimately call
`SessionConnectorService.attach(sessionId, accountId)`.

### Target model: a two-level ladder, no merge

- **Agent-level attachment** (new, persisted, standing): "this agent's
  sessions may use this account." Attach/detach at the agent level is itself a
  consent point (custody disclosure shown), independent of any one session.
- **Session-level attachment** (existing behavior, now persisted): an
  explicit **override** for one session — either an explicit _attach_
  (exposes an account the agent has not standingly attached) or an explicit
  _detach_ (suppresses an account the agent HAS standingly attached, for this
  session only).
- **Precedence: session > agent, no merge**, mirroring the Claude Code MCP
  config ladder (project scope fully overrides user scope for a given server
  name — no field-level merge within one entry). Applied per-account: if a
  session carries an explicit record for account X (attach or detach), that
  record is authoritative for X in that session, full stop. Accounts with no
  session-level record inherit the agent's standing attachment.
- Effective exposed-account set for a session:
  `(agentAttachments(agentId) ∪ sessionOverrides.attached) \ sessionOverrides.detached`

### Persistence: SQLite, following `connected_accounts`' pattern

Connectors have no durable store today (`connected_accounts` is a routing
cache, not a consent record). Two new tables, ADR-0043-shaped (file-first
patterns don't apply here — there is no per-agent `agent.json` field for this
and adding one would put OAuth-adjacent consent state in a file synced by
tools not built to guard it; SQLite already owns `connected_accounts` and is
the existing home for connector state):

- `agent_connector_attachments(agent_id, account_id, attached_at)` — PK
  `(agent_id, account_id)`. Row exists = standing consent. Deleting the row
  IS agent-level detach.
- `session_connector_attachments(session_id, account_id, state, updated_at)`
  — PK `(session_id, account_id)`. `state` is `'attached' | 'detached'` — the
  override record described above. Existing session behavior (attach only,
  no detach persistence) becomes a special case: a session `attach` writes
  `state='attached'`; a session `detach` writes `state='detached'` (a
  tombstone, not a row delete — the whole point is to remember the override
  even when it suppresses an inherited agent attachment).

Both tables are pure intent records — never a resolved `McpAppServerConnection`
(unserializable, provider-held). Restart or process start always re-resolves
the connection via `ConnectorProvider.toolServerForAccount` before it is
usable; nothing tool-shaped is ever read back from SQLite.

### Restart semantics

On restart the two tables are intact (SQLite, not the in-memory `_sessions`
map). `SessionConnectorService._sessions` still starts empty — connections are
live provider resolutions, not data. **Hydration is per-session, on-demand,
idempotent**: `SessionConnectorService.hydrateSession(sessionId, agentId)` is
called once, before a session's first turn after process start (from
`ClaudeCodeRuntime.sendMessage`, which is already async and already resolves
`agentId` via `meshCore.getSubjectByPath(session.cwd)` — no new lookup
primitive needed). It computes the effective set from both tables and calls
the same internal resolution path `attach()` uses, populating the in-memory
cache exactly as a live attach would. A session already hydrated in this
process (tracked by a `Set<sessionId>`) is a no-op on a second call — cheap
enough to call unconditionally per turn.

This is deliberately NOT a boot-time sweep of every session on disk: sessions
that never run another turn never need their tools resolved, and a provider
call is not free. A session's tools are correct by the time its next turn
runs, which is the only time they are read.

### Revocation cascades

- **Agent-level detach** (`DELETE
/api/agents/:agentId/connectors/:accountId`): deletes the
  `agent_connector_attachments` row. Live sessions of that agent already
  hydrated keep the cached connection until their process restarts or the
  session is explicitly re-hydrated — this mirrors `invalidateProvider`'s
  existing "consent survives, resolution is what's revoked" pattern for the
  provider-unregister case, and is bounded the same way: a session's next
  `attach`/`detach` call (or the account's provider going away) forces a
  fresh read. Documented, not silently inconsistent — see Design Decisions.
- **Account disconnect cascades** (existing `ConnectorRegistry.disconnect` /
  a provider revocation): deletes the account's row from BOTH
  `agent_connector_attachments` and `session_connector_attachments`
  (`ON DELETE CASCADE` is not usable — `connected_accounts.accountId` is a
  provider-scoped id, not necessarily an SQLite FK target across all callers;
  the registry's `disconnect` explicitly deletes the two attachment tables'
  rows for that account id in the same transaction path) and calls
  `sessionConnectorService.invalidateProvider`-equivalent so every live
  in-memory cache entry for that account is dropped immediately, in every
  session, not just the one that happens to `attach` next. A disconnected
  account must never keep answering tool calls.

### API surface (new)

- `POST /api/agents/:agentId/connectors/:accountId` — attach at agent level.
  Body: none. Response: `{ account, disclosure }` (custody disclosure,
  re-shown — same shape as the session route's `AttachResult` minus the
  session-only `warning`, since an agent-level attach does not resolve a
  connection itself).
- `DELETE /api/agents/:agentId/connectors/:accountId` — detach at agent
  level. Idempotent.
- `GET /api/agents/:agentId/connectors` — list this agent's standing
  attachments (account id, toolkit, label, status, attachedAt).
- Existing session routes (`/api/sessions/:id/connectors*`) are UNCHANGED in
  shape; `attach`/`detach` now also persist the override row (additive,
  invisible on the wire).
- MCP: `connector.attach_account` / `connector.detach_account` stay
  session-scoped (per D7/existing scope); a new pair
  `connector.attach_account_to_agent` / `connector.detach_account_from_agent`
  wraps the agent-level routes for parity — agent-scoped like the messaging
  bindings already are.

### DirectTransport / Obsidian path

Decision: **no separate wiring.** `SessionConnectorService`,
`ConnectorRegistry`, and the two new tables live in `apps/server` and are
transport-agnostic — `DirectTransport` calls the same in-process route
handlers / capability invocations as `HttpTransport` calls over the wire, and
Obsidian sessions run through the identical `ClaudeCodeRuntime.sendMessage`
hydration hook. There is no Obsidian-specific session or agent identity model
to bridge. Recorded here because the ticket calls it out explicitly, not
because there is a gap to close.

### Acceptance criteria (Part 1)

- AC1.1 Attaching an account to an agent persists a row; after a full
  process restart (new `ConnectorRegistry`/`SessionConnectorService`
  instances, same DB file), a NEW session of that agent still gets the
  account's tools on first turn, without any explicit session-level attach.
- AC1.2 A session-level `detach` on an account the agent has standingly
  attached suppresses that account for that session only; a sibling session
  of the same agent still gets it.
- AC1.3 A session-level `attach` on an account the agent has NOT attached
  exposes it for that session only; a sibling session does not get it.
- AC1.4 No merge: the session record, when present for an account, is fully
  authoritative — this is exercised by AC1.2/1.3, not a separate mechanism.
- AC1.5 Disconnecting an account (`ConnectorRegistry.disconnect`/provider
  revoke) removes it from every agent's and every session's persisted
  attachment rows, and no in-memory cache in the process keeps exposing it.
- AC1.6 Custody disclosure is returned by the agent-attach endpoint and
  remains visible via the existing per-session status/list endpoints — no
  new opt-out path.

---

## Part 2 — One chat, one agent

### Audited facts (binding-store.ts, pre-change)

- `resolve()` scores candidates and does `.sort((a,b) => b.score-a.score)[0]`
  — `Array.sort` is stable, `getByAdapterId` returns `Map` insertion order,
  so two same-specificity bindings tie-break to whichever was created FIRST,
  silently. The second binding is live, valid, and permanently unreachable.
- `resolve()` does not filter `enabled` — a higher-scoring DISABLED binding
  wins the sort over a lower-scoring ENABLED one, so a paused specific
  binding can block a wildcard fallback from ever being tried.

### Uniqueness

**Scope: `(adapterId, chatId)` where `chatId` is a real, non-empty value.**
Wildcard/policy bindings (`chatId` absent — "all DMs on this adapter", "all
messages on this adapter") are exempt: they are not "a chat," they're a
fallback policy, and an adapter legitimately carries more than one
(`channelType`-differentiated) policy binding today. "One chat, one agent" is
about the former, not the latter — see Design Decisions for why the scope
does not also cover `channelType`.

- `BindingStore.create()` rejects a create whose `(adapterId, chatId)` (chatId
  non-empty) already matches an existing binding, regardless of `enabled`
  state — a paused binding still owns its chat. Throws `BindingConflictError`
  carrying the conflicting binding's `id`/`agentId`/`label`.
- `BindingStore.update()` re-checks the same constraint when `chatId` is
  being changed (to a non-empty value) or `adapterId`... `adapterId` is never
  mutable via update, so only a `chatId` change can newly collide.
- **Legacy data**: `load()` gains a dedup pass — when two loaded bindings
  collide on `(adapterId, non-empty chatId)`, the OLDEST (`createdAt`) is
  kept, the rest are logged as discarded (mirrors the existing
  invalid-entry-discard-and-resave pattern) so a pre-existing corrupt
  `bindings.json` self-heals into a state the new invariant can enforce going
  forward.

### Move semantics

`POST /api/relay/bindings/:id/move` — body `{ agentId: string }`. Re-points
an EXISTING binding's `agentId` in place (the one mutation `update()`
deliberately refuses, per its own doc comment — bindings are normally
re-created, not re-pointed; `move` is the one narrow, named exception).
Validates the target agent exists in the mesh registry (400 if not). On
success:

- Clears every session-map entry keyed `${bindingId}:*` via a new
  `BindingRouter.clearSessionsForBinding(bindingId)` — the old sessions were
  created in the OLD agent's project directory and are meaningless once the
  binding points elsewhere; the next inbound message creates a fresh session
  under the new agent.
- Broadcasts `broadcastBindingsChanged()` (existing SSE signal).
- Emits the existing `config.binding_updated`-shaped activity event.

The create-conflict response (409) carries the conflicting binding so a
client can offer "This chat reaches {agentId}. Move it to {newAgentId}?" by
calling `move` on the CONFLICTING binding's id with the new agent — not by
retrying the create. This is why `move` targets an existing binding rather
than being a `force` flag on create: the object that should keep its
identity (session map key, `id`) is the one that already exists.

### `resolve()` `enabled` fix

`resolve(adapterId, chatId, channelType)` now scores and returns only
candidates with `enabled !== false`. A second method,
`resolveIncludingDisabled(...)`, runs the identical scoring over ALL
candidates (used only by the router's fallback below) so the existing
"this chat is paused" refusal (`binding_paused`, DOR-789's told-not-silent
policy) is not lost when the disabled binding is the ONLY candidate for that
chat: `BindingRouter.handleInbound` tries `resolve()` first; on a miss it
calls `resolveIncludingDisabled()` — a hit there means "the reason nothing
matched is that it's paused," a miss means true `no_binding`.

### Acceptance criteria (Part 2)

- AC2.1 Creating a binding for `(adapterId, chatId)` already owned by another
  binding returns 409 with the conflicting binding's id/agentId; the second
  binding is never created (no silent shadow).
- AC2.2 `PATCH` a binding's `chatId` to a value already owned elsewhere also
  409s via the same check.
- AC2.3 `move` re-points `agentId` on the existing row, in place; `id` is
  unchanged; old per-chat sessions for that binding are gone from the session
  map after the call (next inbound creates a new session under the new
  agent's project).
- AC2.4 A disabled specific binding never wins `resolve()` over an enabled
  wildcard on the same adapter+chat namespace — negative control: prove the
  wildcard fires by asserting the DISPATCHED agent is the wildcard's, not the
  disabled binding's.
- AC2.5 When the only candidate for a chat is disabled, the router still
  emits the `binding_paused` notice (not a silent `no_binding` drop) —
  regression guard for the `resolveIncludingDisabled` fallback.
- AC2.6 A `bindings.json` file loaded with two colliding legacy entries keeps
  the older one and logs the newer as discarded; the file is re-saved clean.

---

## Part 3 — Claim feed for unclaimed chats

### Current state

`BindingRouter.handleInbound` — when `bindingStore.resolve(...)` returns
`undefined` — calls `this.drop(..., { reason: 'no_binding', visibility:
'silent' }, ...)`. The message vanishes: a log line, nothing durable, nothing
the operator can act on short of reading server logs.

### Target: a durable, damped, metadata-only record + verbs

New table `unclaimed_chats`:

```
id            TEXT PRIMARY KEY (uuid)
adapter_id    TEXT NOT NULL
chat_id       TEXT NOT NULL
channel_type  TEXT             -- nullable, as observed
chat_kind     TEXT NOT NULL    -- 'dm' | 'group' — from the relay SUBJECT's channel segment, not the payload
sender_name   TEXT             -- display name only, nullable, truncated to 200 chars
sender_id     TEXT             -- platform user id, nullable
chat_title    TEXT             -- group/channel display title (payload.channelName), nullable, truncated to 200 chars
status        TEXT NOT NULL    -- 'pending' | 'claimed' | 'ignored' | 'blocked'
message_count INTEGER NOT NULL DEFAULT 1   -- damping counter
first_seen_at TEXT NOT NULL
last_seen_at  TEXT NOT NULL
decided_at    TEXT             -- claim/ignore/block timestamp
decided_agent_id TEXT          -- set on claim
UNIQUE (adapter_id, chat_id)
```

Pending rows are capped at 200, oldest-`first_seen_at`-evicted, since a
publicly-discoverable bot means this table is reachable by a stranger
(adversarial review MAJOR 4). `relay_chat_unclaimed` broadcasts are
separately rate-limited (20/minute) across DIFFERENT chats — per-chat damping
above only bounds repeats of the SAME chat — with a `relay_chat_unclaimed_burst`
summary event firing once per window when the cap is hit.

**No message body field exists in this table, and no code path reads
`envelope.payload`'s text/body into it — only `platformData`'s identity
fields (already parsed today for `per-user` session-key extraction) plus the
subject-derived `adapterId`/`chatId`/`channelType`.** This is the one
invariant with a named test (below), because it is also the one invariant
that, if violated, would feed an unclaimed stranger's text to a model for
free with zero consent — exactly the prompt-injection surface the plan calls
out.

### Damping

First inbound message for an `(adapterId, chatId)` with no binding: insert
the row (`status='pending'`, `message_count=1`), emit ONE global event. Every
subsequent unbound inbound message on the same chat while `status='pending'`:
bump `message_count` and `last_seen_at`, emit NOTHING. A chat that is
`status='ignored'` behaves the same (count bumps, silent, no re-notify — the
"mute" case: recorded but never resurfaces). A chat that is
`status='blocked'` is checked FIRST and short-circuits before any store
write — genuinely recordless, per spec: no row touch, no count, nothing.

### Verbs

- `GET /api/relay/unclaimed-chats?status=pending` — list (default `pending`).
- `POST /api/relay/unclaimed-chats/:id/claim` — body:
  `{ agentId: string, sessionStrategy?, permissionMode?, label? }` (the
  binding-creation fields `CreateBindingRequestSchema` needs beyond
  `adapterId`/`chatId`/`agentId`, which the route fills in from the
  unclaimed row). Creates a binding through `BindingStore.create()` — the
  SAME uniqueness-checked path as Part 2, so a race against a manually
  created binding for the same chat 409s exactly like any other create would.
  On success: `status='claimed'`, `decidedAgentId`, `decidedAt` set; returns
  the new binding.
- `POST /api/relay/unclaimed-chats/:id/ignore` — `status='ignored'`.
  Idempotent.
- `POST /api/relay/unclaimed-chats/:id/block` — `status='blocked'`.
  Idempotent. From this point the router's blocked-check short-circuits
  before ANY unclaimed-store write for that `(adapterId, chatId)`.

### Router integration

`BindingRouter.handleInbound`, on `bindingStore.resolve()` miss (both the
enabled and the `resolveIncludingDisabled` fallback from Part 2 come back
empty — a truly unbound chat, not a paused one):

1. `unclaimedChats.isBlocked(adapterId, chatId)` → true: `drop(...,
{ reason: 'blocked', visibility: 'silent' }, ...)`, no store write.
2. Else `unclaimedChats.recordSighting({ adapterId, chatId, channelType,
senderName, senderId, chatKind })` → returns whether this was a
   first-sighting insert. First-sighting: emit
   `eventFanOut.broadcast('relay_chat_unclaimed', { id, adapterId, chatId,
channelType, chatKind, senderName, firstSeenAt })` (mirrors
   `broadcastRelayFlow`'s pattern exactly — an invalidation/attention signal
   on the existing global `/api/events` stream, for the client's
   Waiting-On-You/Pulse surfaces to subscribe to in DOR-857).
3. `drop(..., { reason: 'no_binding', visibility: 'silent' }, ...)` as
   before — **the in-chat silence is unchanged**; recording a claim card is
   an operator-facing, cockpit-only signal, never a message back into the
   stranger's chat (spec §8: the bot stays silent until claimed).

### The no-turn invariant

Structural, not incidental: the claim-feed branch above is reached and
returns BEFORE `resolveSession`, before `agentManager.createSession`, before
`relayCore.publish` to any `relay.agent.*` subject. An unclaimed chat cannot
reach an agent because the code that would start a turn is never called —
this is provable by asserting, for an unbound inbound message,
`agentManager.createSession` was never invoked and `relayCore.publish` was
never called with a `relay.agent.*` subject, using the existing fake
collaborators the router's tests already inject.

Claiming a chat does **not** replay the triggering message — there is
nothing to replay (the body was never stored) — only genuinely new inbound
messages after the binding exists get routed. This is enforced by
construction, not a check.

### Acceptance criteria (Part 3)

- AC3.1 First unbound inbound message on a chat creates one `unclaimed_chats`
  row and fires exactly one `relay_chat_unclaimed` broadcast.
- AC3.2 A second unbound inbound message on the same chat (still pending)
  bumps `message_count`/`last_seen_at` and fires NO second broadcast.
- AC3.3 No code path reachable from an unbound inbound message ever reads
  `envelope.payload`'s message-body field into anything persisted or
  broadcast — asserted by constructing an envelope whose body contains a
  sentinel string and grepping the row + the broadcast payload for its
  absence (negative control, not just "the field is typed without a body
  key").
- AC3.4 `claim` creates a binding via the same conflict-checked
  `BindingStore.create()` path; claiming a chat a manual binding has since
  taken (race) 409s the same way Part 2's AC2.1 does.
- AC3.5 `ignore` and `block` are idempotent and change no other chat's row.
- AC3.6 `block` prevents ANY further row mutation for that chat — assert the
  row's `message_count`/`last_seen_at` is unchanged after a second inbound
  message post-block.
- AC3.7 For an unbound inbound message, `agentManager.createSession` is never
  called and `relayCore.publish` is never called with a `relay.agent.*`
  subject — the no-turn invariant, independent of claim-feed recording
  succeeding or failing.

---

## Non-goals

- Client/UI consumption of any of this (DOR-857).
- Move 3 (chats-as-channels bridge) — separate, already-spec'd program
  (`specs/chats-as-channels/`).
- Retrofitting agent-level attachment/hydration into codex or opencode
  runtimes — `setMcpServerFactory` and connector tool exposure are
  claude-code-only today (pre-existing scope of `session-exposure.ts`); this
  spec does not widen that.
- Changing `channelType`'s role in `resolve()`'s scoring tiers.

## What DOR-857 (client) consumes

- `GET/POST/DELETE /api/agents/:agentId/connectors*` (Part 1).
- `POST /api/relay/bindings/:id/move` and the 409 conflict shape from `POST
/api/relay/bindings` (Part 2).
- `GET /api/relay/unclaimed-chats`, the three per-item verb routes, and the
  `relay_chat_unclaimed` SSE event on `/api/events` (Part 3).

## What DOR-749 should inherit

DOR-749's original intent (session-level connector attachment persistence)
is superseded by this spec's `session_connector_attachments` table — Part 1
ships it as a side effect of building the agent-level ladder, since the two
had to share one hydration path to make precedence work at all. DOR-749
should be closed as done-via-DOR-856, not implemented separately.
