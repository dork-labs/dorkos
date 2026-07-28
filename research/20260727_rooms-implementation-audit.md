---
title: 'Rooms, DMs and channels — audit of the shipped implementation'
date: 2026-07-27
type: codebase-audit
status: active
tags: [rooms, channels, dms, addressing, mentions, cascade-guard, sessions]
feature_slug: room-participation
---

# DorkOS Rooms/Channels/DMs — Current Implemented State

Scope note: this is a code-only map. `rooms` (spec `260726-170533`) is manifest-status
`"specified"` (`specs/manifest.json:33-37`) even though the feature is fully built —
the manifest status appears to lag the code. `community-adapter` (`specified`) and
`community-server` (`ideation`) are genuinely spec-only; nothing in this report is
drawn from them. `adapter-agent-routing` and `auto-hide-tool-calls` are marked
`"implemented"` in the manifest but (per investigation below) that implementation
lives entirely on the **session-chat** side, not rooms.

---

## 1. Data model

Schema file: `packages/db/src/schema/rooms.ts`, exported from
`packages/db/src/schema/index.ts:25`.

- **`authors`** (`packages/db/src/schema/rooms.ts:30-65`) — the universal identity
  table: `id` (opaque ULID, minted once), `kind` (`'human' | 'agent' | 'system'`,
  line 37), `naturalKey` (an agent's `agentPath`, `'local'` for the human, `'system'`
  for the room's own voice — line 44), `displayName`, `emoji`, `color` (render
  caches, refreshed on resolve). Unique on `(kind, naturalKey)` (line 64). Deliberately
  NOT the agent manifest ULID, because that can be rebuilt by the mesh reconciler
  (ADR-0043) — comment at lines 16-19.
- **`rooms`** (lines 80-120) — `id` (ULID), `kind` (`'channel' | 'dm' | 'thread'`,
  line 87), `parentId` (non-null only for `kind='thread'`, one level deep — line 89),
  `slug` (channels only, partial-unique among non-archived channels via raw-SQL
  predicate, lines 111-117), `title`, `topic`, `workspaceId`, `rootEntryId` (threads
  only), `archived`, `createdAt`, `lastActivityAt`.
- **`roomMembers`** (lines 134-149) — composite PK `(roomId, authorId)`;
  `responseMode: 'always' | 'direct-only' | 'mention-only' | 'silent'` (line 141,
  the per-room override of `AgentBehaviorSchema.responseMode`); `lastReadSeq` IS the
  read cursor — not per-client, not per-session, not localStorage (line 125).
- **`roomEntries`** (lines 170-210) — the durable, **never-trimmed** append-only log
  (contrast with the in-memory `EventLog` capped at 5000 and `session_events`
  trimmed to the same cap — lines 154-157). PK `(roomId, seq)`; `seq` is per-room
  monotonic, allocated inside an `IMMEDIATE` transaction (lines 159-164); `kind:
'post' | 'notice'`; `body` is JSON `RoomEntryBody`; `mentions` is a JSON array of
  author ids **resolved once at write time** (line 189-191, see §5); `sessionId`
  (the session that produced it, nullable); `cascadeRoot` / `cascadeDepth` (loop-guard
  provenance, see §7); `signature` reserved/always-null for a future phase-4 (line
  200-201).
- **`roomSessions`** (lines 220-229) — composite PK `(roomId, authorId)`, one row per
  `(room, agent)` binding a `sessionId`. Doc comment states the multi-agent intent
  explicitly: _"Three agents in a room means three rows here — three sessions on one
  stream, each keeping its own runtime binding (ADR-0255)"_ (lines 215-218).

**Channel vs DM**: both are `rooms.kind` values on the same table; the distinguishing
rule lives in service logic, not schema constraints — a DM is de-duplicated on its
exact member set (`RoomService.createRoom`,
`apps/server/src/services/rooms/room-service.ts:267-278`, `RoomStore.findDmByMemberSet`),
a channel is de-duplicated on its live `slug` (`room-service.ts:226-227`).

**Multiple agent members in one room**: yes, structurally — `roomMembers` has no
cardinality constraint on `kind='agent'` rows, and `roomSessions` is explicitly
documented and implemented as one row per `(room, author)` so N agents in a room hold
N independent sessions (`room-service.ts:76-78`; `room-store.ts:577-584`
`bindRoomSession`, first-write-wins "mirroring the runtime binding … ADR-0255").

### `packages/relay`

`packages/relay/src` is a **separate subsystem**, not the rooms transport. Its
`lib/subjects.ts` defines the `relay.agent.*` subject grammar for the relay message
bus (mesh agent endpoints, runtime-scoped sessions, legacy sessions —
`packages/relay/src/lib/subjects.ts:1-186`) used by relay adapters
(`adapters/slack/`, `adapters/telegram/`, `adapters/webhook/`,
`adapters/claude-code/`, `adapters/test-mode/`) for **external-integration** delivery
(Slack, Telegram, webhooks) with its own delivery pipeline, budget enforcer, circuit
breaker, dead-letter queue, etc. (`packages/relay/src/delivery-pipeline.ts`,
`budget-enforcer.ts`, `circuit-breaker.ts`, `dead-letter-queue.ts`). Rooms do **not**
route through relay: `room-service.ts:8-11` states relay's budget envelope
"does not reach here" and explains why (`cascade-guard.ts:1-11` — going through relay
"would re-add the per-endpoint file writes and per-endpoint watchers the multi-user
research already rejected"). ADR `decisions/260726-193526-channel-is-a-conversation-relay-is-an-integration.md`
names this split explicitly (title alone makes the boundary clear; not read in full
for this report but the filename is corroborated by the room-service comment).

---

## 2. Message flow (human → room)

Client:

- `apps/client/src/layers/widgets/room-view/ui/RoomComposer.tsx:33-74` — reads/writes
  a room-scoped draft (`useRoomDraft`/`useRoomDraftStore`), renders the shared
  `ChatInput` (from `@/layers/features/chat`), calls `usePostToRoom().mutate({roomId, text})`
  on submit.
- `apps/client/src/layers/entities/room/model/use-post-to-room.ts:44-56` —
  TanStack `useMutation` calling `transport.postToRoom(roomId, {text})`. Writes
  **nothing** into any client cache optimistically — comment at lines 4-11: the
  server mints `seq`, so the client waits for the entry to arrive back over SSE.
- `apps/client/src/layers/shared/lib/transport/room-methods.ts:66-71` —
  `postToRoom` → `POST {baseUrl}/rooms/:id/entries`.

Server:

- `apps/server/src/routes/rooms.ts:141-155` — `POST /:id/entries` resolves the caller
  via `resolveCaller` (`apps/server/src/routes/room-caller.ts:28-35`, which reads
  `X-DorkOS-Agent` identity or falls back to the single local-human author; **never**
  trusts an author id in the body), calls `RoomService.post`, returns **202** with
  `{accepted: true, entryId, seq}` — trigger-only, same pattern as
  `POST /api/sessions/:id/messages` (ADR-0264, comment at `rooms.ts:6-10`).
- `RoomService.post` (`apps/server/src/services/rooms/room-service.ts:553-602`) —
  validates membership/archived state, resolves `@mentions` via
  `resolveMentions` (`mentions.ts`), derives cascade provenance
  (`deriveCascade`, `cascade-guard.ts`), appends the entry (`RoomStore.appendEntry`),
  publishes it to the room's SSE broadcaster + the global `/api/events` fan-out
  (`publishEntry`, lines 801-809), then calls `this.triggers.dispatch(room, entry)`
  **without awaiting it** (line 600 comment: "the HTTP 202 must not wait on a model
  call").
- `RoomTriggerDispatcher.dispatch` (`apps/server/src/services/rooms/room-trigger.ts:187-204`)
  — selects targets (`addressing.ts`), runs the cascade guard, reserves turn budget,
  and for each surviving target calls `runOne`, which invokes
  `RoomTurnRunner.run` (line 374).
- `createSessionRoomTurnRunner` (`apps/server/src/services/rooms/room-turn-runner.ts:61-135`)
  — resolves the runtime type from the agent's manifest (`resolveRuntimeType`, lines
  216-224, falling back to `runtimeRegistry.getDefaultType()`), gets/creates a
  session projector, and calls the **same** `triggerTurn` helper session chat uses
  (`apps/server/src/services/session/trigger-turn.ts:165`), passing
  `composeRoomPrompt(request)` (lines 147-156) as the message content.
- The reply is read back off the **session's own event stream**
  (`collectReply`, lines 177-203: subscribes from a pre-trigger cursor, accumulates
  `text_delta`, stops at `turn_end`) — not returned by `triggerTurn` directly — then
  `RoomTriggerDispatcher.runOne` posts it back into the room via
  `RoomTriggerWriter.post` (`room-trigger.ts:386-391`), which round-trips through
  `RoomService.post` again, carrying `trigger: {root, depth}` provenance.
- That second `RoomService.post` call publishes the reply on the room's SSE stream,
  where it is picked up by every subscriber, including the human's client.

Server → client (delivery): `apps/server/src/routes/room-events-handler.ts` — durable
per-room SSE at `GET /api/rooms/:id/events`, snapshot → gap-free replay via
`Last-Event-ID`/`?after=` → live (same three-part contract as the session stream,
comment at lines 4-5). `apps/client/src/layers/shared/lib/transport/room-methods.ts:110-171`
`subscribeRoom` consumes it with its own silence watchdog (comments needed because
the server heartbeats via SSE **comments**, dropped before reaching the consumer,
lines 99-107).

**Which routes handle what**: `apps/server/src/routes/rooms.ts` (all `/api/rooms/*`)
is entirely separate from `POST /api/sessions/:id/messages` (session-direct chat,
not read in full for this report but referenced repeatedly as the sibling path both
`room-turn-runner.ts:210-213` and `trigger-turn.ts` doc comments compare against).
Both ultimately funnel through the same `triggerTurn` (`apps/server/src/services/session/trigger-turn.ts`)
and the same per-session `SessionStateProjector` / SSE delivery machinery — a room
turn is, by construction, "a normal session turn, visible on
`GET /api/sessions/:id/events` like any other" (`room-turn-runner.ts:14-16`).

---

## 3. Session binding

**One session per (room, agent), not one per room.** `roomSessions`
(`packages/db/src/schema/rooms.ts:220-229`) is keyed `(roomId, authorId)`. Confirmed
in `RoomStore`:

- `getRoomSession(roomId, authorId)` — `apps/server/src/services/rooms/room-store.ts:558-565`.
- `bindRoomSession(roomId, authorId, sessionId, createdAt)` —
  `room-store.ts:577-584`: `INSERT ... onConflictDoNothing()` then re-reads, so the
  first writer wins ("mirroring the runtime binding it will carry (ADR-0255)",
  doc comment lines 568-569).

Binding happens **before** the turn runs, inside `RoomTriggerDispatcher.claimTargets`
(`room-trigger.ts:308-321`) — explicitly to close a race the code documents having
hit in practice: reading the binding inside `runOne` instead left "a real session
with its own projector … bound to nothing, whose reply was produced from an empty
context" when two posts landed before the first reply (comment at lines 309-315).

**Runtime resolution**: `resolveRuntimeType` (`room-turn-runner.ts:216-224`) reads
the agent's manifest (`readManifest(agentPath)`) and checks
`runtimeRegistry.has(manifest.runtime)`; if registered, that runtime type is used,
else the room turn falls back to `runtimeRegistry.getDefaultType()`. This
deliberately mirrors `POST /api/sessions/:id/messages`'s own soft fallback (comment
lines 210-213). Once a turn is `accepted`, `runtimeRegistry.persistSessionRuntime`
is called (lines 111-116) with `INSERT-OR-IGNORE` semantics — the room path
participates in the same first-write-wins runtime binding (ADR-0255) that ordinary
sessions use; it does not have its own separate binding rule.

A DM is **not** one session shared by both parties — it is a room (with its own
`roomEntries` log) plus one `roomSessions` row per agent member. A 3-agent channel
has 3 independent `room_sessions` rows, 3 independent per-agent contexts, one shared
`room_entries` log everyone reads and writes onto.

---

## 4. Multi-agent membership

**Yes — this is implemented today, not spec-only.** Evidence:

- `roomMembers` has no 1-agent cap; `RoomService.createRoom` accepts `members:
string[]` and `agentPaths: string[]` and resolves all of them into one roster in
  one transaction (`room-service.ts:218-290`).
- **Addressing** (`apps/server/src/services/rooms/addressing.ts`) — pure function
  `selectTriggerTargets` (lines 77-92) filters the roster to `kind==='agent'` members
  other than the post's own author, then applies each member's `responseMode`:

  | mode           | triggered when (`respondsTo`, lines 50-64) |
  | -------------- | ------------------------------------------ |
  | `silent`       | never                                      |
  | `mention-only` | mentioned                                  |
  | `direct-only`  | room is a DM, or mentioned                 |
  | `always`       | always                                     |

  Doc comment states the intent directly: _"Addressing three agents and getting
  three answers is the intended outcome, not a pathology"_ (lines 6-9).

- **Loop control when multiple agents are bound to one room**:
  `apps/server/src/services/rooms/cascade-guard.ts` — `evaluateCascade` (lines
  67-80) refuses a target when `depth > maxAgentDepth` (config `rooms.maxAgentDepth`)
  or when the target author id already appears in `authorsInCascade` (an ancestry
  rule: A→B→A is refused on the **first** repeat, not after N wasted calls — module
  doc lines 13-15). `RoomTriggerDispatcher.claimTargets` (`room-trigger.ts:226-330`)
  evaluates **all** targets before claiming any of them (so two agents addressed by
  one message don't cancel each other out — comment lines 219-225), then applies a
  **turn budget** (`turn-budget.ts`, two ceilings: per-room and global, both rolling
  1-hour windows, in-memory only — `RoomTurnBudget.tryReserve`, lines 143-162).
  A refused trigger writes a visible `notice` entry into the room
  (`buildCascadeNotice` / `buildBudgetNotice`, `cascade-guard.ts:154-183`), deduped
  per `(room, cascade, author)` so it fires once per exhaustion, not once per message
  (`room-trigger.ts:407-436`, `NOTICE_MEMORY = 512` FIFO cap at line 128).
- **Seeding a second agent is operator-only**: `RoomService.requireSeedingAllowed`
  (`room-service.ts:791-799`) — an agent opening a room for itself is fine; an agent
  cannot put a _second_ agent into a room it creates (only the local human can,
  enforced identically in `addMember`, `room-service.ts:464-470` via
  `requireOperator`). Doc comment: "an agent that could widen another agent's
  addressing could drive replies nobody asked for" (`room-service.ts:11-16`).

So: routing logic for 2+ agents in one channel exists and is exercised —
`addressing.ts` decides who gets triggered, `cascade-guard.ts` + `turn-budget.ts`
bound the resulting agent-to-agent loop, and `room-trigger.ts` is the orchestrator
tying them together. This is a genuinely multi-agent room implementation, already
shipped (per the `rooms` spec at `260726-170533`, referenced throughout this code as
"spec `rooms` §5/§6" even though its manifest status string says "specified").

---

## 5. @mentions

**Server-side, regex-based, resolved once at write time — there is no client
autocomplete for room/agent mentions.**

- `apps/server/src/services/rooms/mentions.ts` — `resolveMentions(text, roster)`
  (lines 55-74) matches `MENTION_PATTERN = /@([A-Za-z0-9][A-Za-z0-9_.-]*)/g`
  (line 36) against the room's `mentionCandidates` (agent handle first, then
  `displayName` — `room-roster.ts:178-192`), case-insensitively, first-claim-wins.
  Resolved once when `RoomService.post` writes the entry
  (`room-service.ts:582`: `mentions: resolveMentions(input.text, this.roster.mentionCandidates(roomId))`)
  and stored as a JSON array of author ids on `roomEntries.mentions`
  (`packages/db/src/schema/rooms.ts:189-191`). Deliberately not re-parsed on render
  — doc comment: _"renaming an agent tomorrow cannot silently re-address a message
  sent today"_ (`mentions.ts:4-8`).
- **No client-side mention-autocomplete component exists for rooms.**
  `RoomComposer.tsx` renders the raw `ChatInput` primitive
  (`apps/client/src/layers/features/chat/ui/input/ChatInput.tsx`) directly — it does
  **not** wrap it in `ChatInputContainer` and passes none of `onCursorChange`,
  `isPaletteOpen`, `activeDescendantId`, etc. (`RoomComposer.tsx:50-73`). Those
  autocomplete wiring props are only consumed by
  `apps/client/src/layers/features/chat/model/use-input-autocomplete.ts`, which is
  used by `ChatInputContainer.tsx` in **session chat**, not by rooms.
- **The only `@` autocomplete that exists anywhere in the client is a FILE picker**,
  scoped to session chat: `use-file-autocomplete.ts` — `detectFileTrigger` matches
  `/(^|\s)@([\w./:-]*)$/` (line 70) and, on selection, inserts the literal text
  `before + '@' + entry.path + after` (`handleFileSelect`, lines 82-99) — i.e. a
  file mention is a **plain-text token embedded in the message body**
  (`@path/to/file`), not a resolved attachment or a structured payload field. There
  is no schema field carrying file references separately from `text`.
- **Net effect for rooms**: if a person types `@` in a room composer today, nothing
  suggests anything — no file picker (not wired), no agent picker (does not exist
  anywhere in the codebase). The server-side mention resolution only fires if the
  exact handle/display-name string happens to appear in the raw text. This is the
  sharpest UX gap in the current implementation for room addressing.

---

## 6. Verbosity / event rendering

**Rooms do not carry raw session events at all — only final assistant text.** This
makes the question moot for rooms in its literal form (there is no tool-call data in
a room entry to hide), but it is worth stating precisely because a design built on
top of rooms will likely want to change this:

- `collectReply` (`apps/server/src/services/rooms/room-turn-runner.ts:177-203`)
  subscribes to the triggered session's projector and accumulates **only**
  `text_delta` events, stopping at the first `turn_end` (lines 186-188) — tool calls,
  thinking blocks, permission prompts, etc. never reach the text that gets posted
  back into the room.
- `RoomEntryRow.tsx` (`apps/client/src/layers/widgets/room-view/ui/RoomEntryRow.tsx:56-86`)
  renders `entry.body.text` through `MarkdownContent` — there is no tool-call
  renderer, no collapse/expand affordance, nothing to allowlist.
- `TURN_EVENT_TYPES` (`apps/client/src/layers/entities/session/model/session-stream-store.ts:192`)
  and the "hide tool calls" preference
  (`apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`,
  `apps/client/src/layers/features/settings/ui/tabs/PreferencesTab.tsx`) are **session-chat**
  concepts, unrelated to rooms. The `auto-hide-tool-calls` spec
  (`specs/auto-hide-tool-calls/`, manifest status `"implemented"`) is about that
  session-chat surface, confirmed by the code above being entirely under
  `layers/features/chat` and `layers/entities/session`, never touched by any
  `room-view`/`entities/room` file.
- To see an agent's actual tool calls for a room-triggered turn today, a person has
  to open the underlying session directly (each `(room, agent)` binding has a real
  session id, viewable via ordinary session UI) — the room itself only ever shows
  the agent's closing prose.

---

## 7. Turn / concurrency control

- **Session write lock**: `apps/server/src/services/session/session-lock.ts` —
  `SessionLockManager.acquireLock(sessionId, clientId, res, token?)` (lines 37-63)
  is a per-session, per-client TTL lock (`SESSIONS.LOCK_TTL_MS`), refusing a second
  distinct `clientId` while one is held and not expired. Room turns acquire this
  lock through the exact same path session chat uses
  (`triggerTurn`, `apps/server/src/services/session/trigger-turn.ts:165-291`),
  under a **shared** client id constant: `ROOM_CLIENT_ID = 'dorkos-room'`
  (`room-turn-runner.ts:43`) — doc comment: _"two turns for the same agent in the
  same room are the same writer and the second must queue rather than be refused as
  a foreign client"_ (lines 39-42). In practice `triggerTurn` does not queue a
  second call against a lock held by the **same** clientId+session at the
  `acquireLock` layer (that layer only blocks a _different_ clientId); actual
  serialization for a fast double-post to the same agent comes from
  `bindRoomSession`'s first-write-wins semantics (one session id) plus each runtime
  adapter's own internal serialization on that session id — not read in this
  investigation, flagged as unverified beyond the lock/bind layer.
- **When the room's target session is busy with someone else's turn** (e.g. the
  human is directly chatting with that same agent's session while the room also
  addresses it): `acquireLock` returns `false` (different clientId), `triggerTurn`
  returns `{accepted: false}`, and `room-turn-runner.ts:119-130` **drops** the
  trigger — no queueing, no retry, no notice written to the room. Comment: "Skipping
  is right: queueing a second turn behind theirs would answer a room message with
  whatever context their turn leaves behind" (lines 120-123). This is a silent skip
  from the room's perspective — nothing in the room log records that the agent was
  addressed but busy.
- **No typing indicators wired into room UI beyond the raw plumbing.**
  `RoomService.publishSignal(roomId, signal, authorId)`
  (`room-service.ts:706-713`) exists and publishes an ephemeral (`type: 'signal'`,
  never logged, dropped on replay) event using `SignalType` from
  `@dorkos/shared/relay-schemas`. This report did not find a client caller that
  invokes it for rooms (no `publishSignal`/typing call site found under
  `apps/client/src/layers/widgets/room-view` or `entities/room` in the searches
  performed) — the wire-format exists server-side but is, as far as this
  investigation could confirm, unused for rooms today. Flagged unverified rather
  than asserted absent, since a full client-wide search for every `SignalType`
  caller was not exhaustively completed.
- **No message queue for rooms.** Session chat has a message queue
  (`use-message-queue.ts`, referenced in ADR-0273) for typing ahead while an agent
  streams; `RoomComposer.tsx` has no equivalent — `usePostToRoom` fires a bare
  mutation per Enter press with no queueing concept, and posting is always
  trigger-only/fire-and-forget (§2).
- **Cascade/budget as the closest thing to flow control**: the cascade guard
  (§4) and `turn-budget.ts` are the only concurrency-adjacent controls that exist,
  and they bound _automatic_ agent-to-agent replies, not human/agent turn-taking.

---

## 8. Context injection

**Rooms do not use the ADR-0273 `additionalContext` channel.** They use a
different, simpler mechanism: the room framing is baked directly into the literal
`content` string sent to the runtime.

- `composeRoomPrompt(request)` (`apps/server/src/services/rooms/room-turn-runner.ts:147-156`):

  ```
  New message in {where} from {authorName}:

  {entry.body.text}

  Reply as you would in a chat room. Your answer is posted into {where}, where everyone in the room reads it.
  ```

  where `where` is `#{room.slug}` or `room.title`. This is passed as the `content`
  argument to `triggerTurn` (`room-turn-runner.ts:84-107`, `content: composeRoomPrompt(request)`).

- Contrast with ADR-0273 (`decisions/0273-runtime-neutral-context-injection.md`),
  which established a structured, out-of-band `additionalContext` bag specifically
  so that "the user's `content` is never mutated by the client or server" (Decision
  point 1) — git status, UI state, and the queued-message note all ride that
  channel via `assembleAdditionalContext` (`apps/server/src/services/session/trigger-turn.ts:224-232`,
  `context-assembler.ts` — not read in full but referenced at import line 53). Room
  turns still get that same per-turn `additionalContext` bag from `triggerTurn`
  internals (it's assembled unconditionally at trigger-turn.ts:228-232 from `cwd`
  and runtime capabilities) — but the room-specific framing (where the agent is,
  who spoke) is **not** part of that neutral bag; it is pre-composed into `content`
  itself, meaning it is **not pristine** and will render as part of the visible
  "user" turn in the underlying session transcript.
- **What an agent is told about a room, precisely**: which room (name/slug) and who
  wrote the triggering message. **Not told**: who else is in the room (the roster),
  their response modes, the room's topic, or any prior room history beyond what the
  single triggering message contains — `composeRoomPrompt` has access to
  `request.room` (which includes `slug`/`title` only, per the `RoomTurnRequest`
  interface at `room-trigger.ts:50-65`) and `request.entry`/`request.authorName`;
  it does not receive the roster. If the underlying agent session has prior turns
  in that same room (because `roomSessions` binds one session per `(room, agent)` —
  §3), earlier room activity persists in that agent's own session history and would
  be visible to it via ordinary conversational context — but a **fresh** binding
  (an agent's first message in a room) gets no roster/room-topic context beyond the
  one line above.
- **`packages/harness`**: not found to be involved in room context injection at
  all in this investigation — `packages/harness` projects `.agents/` + plugins
  (skills, commands, rules) to on-disk harness config per the AGENTS.md description;
  no reference to it was found in `apps/server/src/services/rooms/` or
  `room-turn-runner.ts`. Room context is generated entirely inline in
  `composeRoomPrompt`, not through the harness/skill-projection system.

---

## Files most load-bearing for this map

- Schema: `packages/db/src/schema/rooms.ts`
- Server services: `apps/server/src/services/rooms/{room-service,room-trigger,room-turn-runner,room-roster,addressing,cascade-guard,mentions,turn-budget,room-store,author-registry}.ts`
- Server routes: `apps/server/src/routes/{rooms,room-caller,room-events-handler}.ts`
- Shared session turn plumbing rooms reuse: `apps/server/src/services/session/{trigger-turn,session-lock}.ts`
- Client: `apps/client/src/layers/entities/room/**`, `apps/client/src/layers/widgets/room-view/**`, `apps/client/src/layers/shared/lib/transport/room-methods.ts`
- Chat input (shared, session-only autocomplete): `apps/client/src/layers/features/chat/{ui/input/ChatInput.tsx,model/use-input-autocomplete.ts,model/use-file-autocomplete.ts}`
- ADRs consulted: `decisions/260726-170125-a-room-is-a-membership-scoped-durable-stream.md` (title/existence only, not opened), `decisions/260726-170126-author-identity-is-keyed-on-the-agents-directory.md` (title only), `decisions/260726-170127-the-room-path-carries-its-own-cascade-guard.md` (title only), `decisions/0273-runtime-neutral-context-injection.md` (read in full)
