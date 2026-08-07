---
title: 'Read/unread state architecture — prior art and a DorkOS proposal (2026-08)'
date: 2026-08-07
type: architecture-proposal
status: active
tags:
  [
    read-state,
    unread,
    rooms,
    sessions,
    community-adapter,
    sse,
    slack,
    discord,
    matrix,
    telegram,
    whatsapp,
  ]
related:
  [
    research/20260806_user-model-and-community-plans-audit.md,
    research/20260729_platform-presence-patterns.md,
    research/20260727_room-spec-corpus-synthesis.md,
    research/20260727_multi-user-review-exchange.md,
    research/20260727_rooms-implementation-audit.md,
  ]
---

# Read/Unread State Architecture — Prior Art and a DorkOS Proposal

Dorian's requirements for a cockpit-wide read state system:

- **(a) global and syncable** — the same chat open in two browsers/devices shows the same read state
- **(b) community-server-compatible** — a future community server must be able to know which users have seen which messages
- **(c) universal** — works for agent chat sessions, DMs, rooms/channels, and inbox-style items
- **(d) per-user** — when multiple humans share a room or DM, each person's read state is tracked separately

This report does three things: distills how Slack, Discord, Matrix, Telegram and WhatsApp actually model read state (Part 1); documents, with exact file paths, the (plural — there are three, and they disagree with each other) mechanisms DorkOS ships today (Part 2); and proposes a model that meets a–d on the current stack (Part 3).

---

## Part 1 — How the best messaging systems model read state

### Slack: server-side cursor, broadcast on write

Slack's unit of read state is a **per-`(user, channel)` cursor**, not a per-message receipt. `conversations.mark` takes a `ts` (the timestamp-as-id of the last message the user has seen) and "sets the read cursor in a channel... moves it for whomever owns the token used in the request." The write is server-authoritative: "the mark is saved to the database and broadcast via the message server to all open connections for the calling user" ([`conversations.mark` docs](https://docs.slack.dev/reference/methods/conversations.mark/)). That broadcast is the load-bearing detail — every open client for that user (desktop, two browser tabs, mobile) receives the new cursor over its own realtime connection, which is exactly how Slack satisfies "global and syncable" without polling. Slack also rate-limits the client (docs advise a timer, not marking on every scroll tick) because the cursor is a coarse position, not a per-message log.

The unread count and the "new messages" line are both **derived**, client-side, from `messages after cursor`. Slack has no separate "unread divider" data structure — it recomputes the divider position from the cursor plus the loaded message list, same as DorkOS's own `UnreadDivider` (see Part 2).

### Discord: the same shape, message-id cursor, ack endpoint

Discord's internal `read_states` model is "an entity that stores user ID, channel ID, and the last read message ID," updated by an `ack` call ([reverse-engineered writeup](https://javatsc.substack.com/p/day-44-read-states-engineering-the)). Because Discord message ids are Snowflakes (time-ordered, monotonically increasing 64-bit ints), the cursor is directly comparable without a second timestamp column — "the server compares that ID to the latest message ID in the channel... if the last read ID is less than the latest ID, the server marks the channel as unread." This is architecturally identical to Slack's model (server-side cursor per `(user, channel)`) with one difference: the cursor is a message id rather than a timestamp, which sidesteps clock-skew and duplicate-timestamp ambiguity entirely. Discord layers optional per-message **social** read receipts (visible "seen" state) only for DMs, added years after the private ack system — the private cursor and the social receipt are explicitly two different features on two different rollout timelines.

### Matrix: the instructive one — it names the two concepts DorkOS needs

Matrix is the most useful prior art because the spec makes the distinction Dorian is asking for **explicit**, as two separate primitives:

- **`m.fully_read`** — "a private bookmark to indicate the point which has been processed in the discussion," stored in **room account data** (private to the user, replicated to all their devices via `/sync`, never shown to anyone else), written via `POST /_matrix/client/v3/rooms/{roomId}/read_markers`. This is the "where did I leave off" cursor.
- **`m.read`** — a **public read receipt**: "public indicators of what a user has seen to inform other participants." Delivered as an ephemeral `m.receipt` event in `/sync`, shaped as `event_id -> receipt_type -> user_id -> data`. A user has exactly one `m.read` receipt per room; moving it also clears notification counts for everything at or before it.
- **`m.read.private`** (a.k.a. hidden receipts, MSC2285) — added later specifically to solve cross-device sync **without** the privacy cost of a public receipt: it lets a user's other devices learn "I've seen this" (so a second device doesn't re-notify) without publishing that fact to the room. This is precisely the private/social split Dorian anticipates DorkOS needing.

Server-computed `notification_count` / `highlight_count` in `/sync` are calculated **relative to the user's last read receipt, not per-device state** — i.e. the server, not any one client, is the source of truth for "is this unread," which is what makes Matrix's model compatible with an arbitrary number of client devices and (via the public `m.read` receipt) with other room members knowing what you've seen. Both markers can be moved together in one call to `/read_markers`, which is the shape DorkOS's own room read-cursor endpoint already mirrors (see Part 2). ([Patrick Cloke, "Matrix Read Receipts & Notifications"](https://patrick.cloke.us/posts/2023/01/05/matrix-read-receipts-and-notifications/); [MSC2285](https://github.com/matrix-org/matrix-spec-proposals/pull/2285))

### Telegram: cursor, but two of them (inbound vs outbound)

Telegram's `dialog` object carries `read_inbox_max_id` (highest incoming message id you've read) and `read_outbox_max_id` (highest of your own messages the _other party_ has read), plus a denormalized `unread_count`. `messages.readHistory` / `channels.readHistory` advance the inbound cursor server-side ([`dialog` constructor](https://core.telegram.org/constructor/dialog)). The two-cursor split is Telegram's way of getting a lightweight "they've seen my message" (outbound) signal without per-message receipts — it's a compressed, cursor-shaped approximation of a read receipt, not a real one. Useful precedent for DorkOS: a second cursor (`lastReadByOtherAt`) is a cheap way to approximate "did they see it" before building full per-message receipts.

### WhatsApp: the opposite end — true per-message receipts

WhatsApp is the outlier in this set: it does **not** use a per-conversation cursor at all. Every message gets its own delivery lifecycle (sent → delivered-to-device → read), and in group chats the read state is tracked **per member per message** (visible via the "message info" screen listing who read it and when). This is what "social read receipts" cost at the limit: O(members × messages) storage and O(members) receipt traffic per message, versus O(1) per `(user, conversation)` for a cursor. It's the right model when the product's core promise is "know if they've seen it," and the wrong model as a default for a cockpit whose primary need is "show me what's new."

### Distillation — the canonical architectures

| Architecture                                         | Storage unit                                                       | Where                                      | Cross-device sync                                              | Who sees it                                      | Examples                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **Cursor-per-conversation**                          | One `(user, thread) → position` row                                | Server                                     | Server broadcasts the write to every open client for that user | Private by default                               | Slack, Discord, Telegram (inbound), Matrix `m.fully_read`                             |
| **Per-message receipts**                             | One row per `(message, viewer)`                                    | Server (or E2E-encrypted protocol message) | Each receipt is itself an event every device receives          | Public/social — the point is other people see it | WhatsApp, Matrix `m.read`                                                             |
| **Hybrid: private cursor + optional social receipt** | Cursor for "where am I," receipts layered on top only where useful | Server, two features                       | Cursor syncs privately; receipts publish deliberately          | Both, chosen per surface                         | Matrix (`m.fully_read` + `m.read`/`m.read.private`), Discord (ack + DM-only receipts) |

**Tradeoffs that matter for DorkOS:**

- **Event-id/seq cursor vs. timestamp cursor.** A monotonic integer or snowflake-style id (Discord, Slack's `ts`, Matrix's event id) is unambiguous and directly comparable; a raw timestamp is vulnerable to clock skew and duplicate values and can't express "the 3rd of 3 messages sent in the same millisecond." Every system above that has a real cursor uses an id/seq, not a bare timestamp — timestamps only show up as _labels_ (Slack's "New messages since 2:14pm"), never as the actual comparison key.
- **Private marker vs. social receipt.** A private cursor answers "what's unread for me" and needs zero consent design. A social receipt answers "who has seen this" and is a genuine privacy decision — Matrix had to retrofit `m.read.private` specifically because its original public-only receipt leaked presence/attention data nobody asked to share. Building the social layer as a _second, optional_ feature on top of an already-correct private cursor (Matrix, Discord's DM receipts) is safer than trying to build one mechanism that serves both from day one.
- **Cursor-per-conversation vs. per-message receipts, as a storage decision.** Cursors are O(1) per `(user, thread)`; receipts are O(members × messages). For a founder-scale cockpit where the primary ask is "what's new," a cursor is the right default; receipts are worth adding only where "seen by" is a feature someone will actually look at (multi-human rooms).

Sources: [Slack `conversations.mark`](https://docs.slack.dev/reference/methods/conversations.mark/) · [Discord read-state internals](https://javatsc.substack.com/p/day-44-read-states-engineering-the) · [Matrix read receipts & notifications](https://patrick.cloke.us/posts/2023/01/05/matrix-read-receipts-and-notifications/) · [MSC2285: private read receipts](https://github.com/matrix-org/matrix-spec-proposals/pull/2285) · [Telegram `dialog` constructor](https://core.telegram.org/constructor/dialog)

---

## Part 2 — What DorkOS has today

There are **three separate, independently-invented mechanisms** in the cockpit right now, and only one of them is server-side.

### Mechanism 1 — Agent chat sessions: pure `localStorage`, per browser, not synced

`apps/client/src/layers/features/chat/model/view/use-unread-cursor.ts` stores, under `dorkos:chat:last-seen:<sessionId>`, the id of the newest message the reader had seen when the view opened. The module's own TSDoc says why it's local-only: _"Client-local by decision (spec `multi-participant-message-list`, D4): for a single-operator cockpit 'new messages' is about THIS browser's last view... It moves server-side when accounts land."_ Key properties:

- Cursor is a **message id**, not a seq or timestamp.
- It's read once per session and **frozen** for the life of the view — `markSeen()` (called from `MessageList.tsx` only once the list is pinned to the bottom and has real scroll geometry, gated on a `measured` flag) is the only writer, and there's deliberately no write-on-unmount.
- Nothing here talks to the server. A second browser or device has no way to know this session was read — the divider would show up fresh in each one.

The divider itself is `apps/client/src/layers/features/chat/ui/message/UnreadDivider.tsx`, a "New messages" rule computed into the row list by `apps/client/src/layers/features/chat/lib/build-list-rows.ts` and rendered by `apps/client/src/layers/features/chat/ui/MessageList.tsx` (`useUnreadCursor(sessionId, newestMessageId)` at line 197).

### Mechanism 2 — Rooms/DMs: server-side, per-`(room, author)`, but not push-synced

Rooms (channels, DMs, and threads — a thread shares its parent channel's membership row per ADR `260728-022013`) have a real server-side cursor: `packages/db/src/schema/rooms.ts`'s `room_members` table carries `lastReadSeq: integer('last_read_seq').notNull().default(0)`, primary-keyed on `(room_id, author_id)` — the schema's own comment states it plainly: _"`last_read_seq` **is** the `(member, room)` read cursor: not per client, not per session, not `localStorage`."_

- **Write path:** `PUT /api/rooms/:id/read-cursor` (`apps/server/src/routes/rooms.ts:329`) → `RoomService.setReadCursor` (`apps/server/src/services/rooms/room-service.ts:1334`) → `RoomStore.setReadCursor` (`apps/server/src/services/rooms/room-store.ts:418`), which is **monotonic** — a `SET ... WHERE last_read_seq < :new` guard means a stale write can never un-read a room. Client side: `apps/client/src/layers/entities/room/model/use-mark-room-read.ts` (`useMarkRoomRead` for the open room, `useMarkRoomReadNow` for "mark as read" from the sidebar without opening it) and `apps/client/src/layers/features/dashboard-sidebar/model/use-mark-rooms-read.ts` for bulk "mark all read."
- **Unread badge:** computed server-side in SQL — `RoomStore.countUnread` (`room-store.ts:871`) and the batch form used for the room list (`room-store.ts:964`): `SUM(CASE WHEN seq > last_read_seq THEN 1 ELSE 0 END)`. The sidebar badge (`RoomRow.tsx`) reads this `unreadCount` directly; `null` means "not a member," never "nothing unread" (`room-service.ts:1063`).
- **Divider:** `apps/client/src/layers/widgets/room-view/model/use-frozen-read-cursor.ts` takes a snapshot of the live `lastReadSeq` **once when the room is opened** and holds it — same "freeze so it doesn't vanish mid-read" pattern as Mechanism 1 — and `RoomTimeline.tsx` renders the **same shared `UnreadDivider` component** from the chat feature at the first entry whose `seq` exceeds the frozen value.
- **The cross-device gap:** `RoomService.setReadCursor` (`room-service.ts:1332-1337`) calls neither `eventFanOut.broadcast(...)` nor `this.broadcaster.publish(...)` — confirmed by reading the method body and grepping every broadcast call site in `room-service.ts`. So a read-cursor write is **never pushed live** to a second open browser/device. The only way a second client catches up is TanStack Query's `staleTime` on the room list (`ROOMS_STALE_TIME_MS = 30_000` in `apps/client/src/layers/entities/room/model/use-rooms.ts`) plus whatever ordinary refetch trigger fires next (refocus, remount, or `useRoomListStream`'s subscription to `room_created` / `room_updated` / `room_member_added` / `room_member_removed` / `room_activity` on the global `/api/events` fan-out — none of which fire on a cursor write). This is the concrete hole in requirement (a) even for the one surface that's otherwise server-side.

### Mechanism 3 — Activity feed "since your last visit": one localStorage timestamp, not itemized

`apps/client/src/layers/features/activity-feed-page/model/use-last-visited-activity.ts` reads a single ISO timestamp from `localStorage` once on mount. `apps/client/src/layers/features/activity-feed-page/ui/ActivitySinceLastVisit.tsx` uses it purely as a filter — `countByCategory(items, lastVisitedAt)` — to build the digest banner ("3 Tasks runs · 1 Relay event") on `apps/client/src/layers/widgets/activity/ActivityPage.tsx`. There's no per-item read state at all here: it's a single watermark, per browser, that resets the framing of "what's new" rather than tracking which specific activity items were seen.

### The good news: the `CommunityAdapter` seam already anticipated this — for rooms

`packages/shared/src/community-adapter.ts` — the port described in AGENTS.md as the fourth swappable seam — already models exactly the private-cursor half of Part 1's distillation:

- `CommunityCapabilitiesSchema.readCursor: z.enum(['server', 'client-opaque', 'none'])` (line 300), with the doc comment stating the server-computed-unread-count consequence of each value in as many words: `'server'` — "the backend stores the cursor and can compute an unread count"; `'client-opaque'` — "a server-computed unread count is **impossible**, not merely unimplemented"; `'none'` — no cursor at all.
- `getReadCursor(roomId): Promise<CommunityCursor | null>` / `setReadCursor(roomId, cursor): Promise<void>` (lines 1312–1323), where `CommunityCursor` is an opaque branded string (`z.string().min(1).brand('CommunityCursor')`, line 162) — deliberately not a bare integer, so a remote backend's native cursor shape (event id, snowflake, whatever) never has to be forced into DorkOS's own `seq` type.
- `CommunityRoomSchema.unreadCount` (line 422) is explicitly `null`-means-"not applicable," with the comment: _"must never render `0`, because a silent room and a room whose unread cannot be computed are different states."_

`apps/server/src/services/communities/local/local-community-adapter.ts` is the reference implementation: it declares `readCursor: 'server'` and its `getReadCursor`/`setReadCursor` (lines 589–609) are thin wrappers around the exact `room_members.last_read_seq` column described above, converting the raw integer to/from an opaque `CommunityCursor` via `mintLocalCursor`/`readLocalCursor`. **This means requirement (b) is already designed for, at the type level, for rooms** — a future Buzz-backed adapter implements the same two methods against its own storage, and callers (badges, dividers, digests) never need to know which backend they're talking to.

What's missing from this seam is everything Mechanism 1 and 3 need: chat sessions and activity items have no `CommunityAdapter`-shaped concept at all (sessions are `AgentRuntime`-owned per ADR-0310, not room-shaped), and even where the seam exists (rooms), nothing pushes a cursor update live.

### Answering directly: how the "new messages" divider actually works

It is **the same visual component reused by two unrelated mechanisms**, and which one you're looking at depends on where you are:

- In an **agent chat session**, the divider comes from `use-unread-cursor.ts` — a message-id watermark in `localStorage`, scoped to one browser, written only when the list is pinned to the bottom, never touching the server. Two devices open on the same session will each compute their own divider independently and can disagree.
- In a **room/DM**, the divider comes from `use-frozen-read-cursor.ts` reading the server-authoritative `room_members.last_read_seq` (via `use-mark-room-read.ts`'s mutation), frozen at room-open time so it doesn't move while you're reading. This one _is_ server-side and _is_ per-author — but because `setReadCursor` never broadcasts, a second open device only picks up the new cursor once its 30-second-stale room-list query happens to refetch, not the instant the first device reads the room.

Neither path is currently "global and syncable" in the sense Dorian wants; the room path is one broadcast call away from it, the session path needs the server-side cursor it doesn't have at all yet.

---

## Part 3 — Proposed architecture

### Recommendation in one paragraph

Generalize the room model — which is already correct in shape (private, monotonic, per-`(user, thread)` integer cursor, server-side, already wired into the `CommunityAdapter` port) — into a single `read_cursors` table keyed `(user_id, thread_kind, thread_id) → last_read_seq`, used by rooms, agent chat sessions, and (later) inbox items alike; give agent sessions the server-side cursor they're missing by riding the monotonic `seq` the durable per-session SSE stream already assigns every event (ADR referenced in AGENTS.md's Sessions section); close the one real gap in the room mechanism by broadcasting every cursor write on the existing global event fan-out (and, when the thread's own durable stream is open elsewhere, on that stream too) so a second device updates without waiting on `staleTime`; keep every cursor a **private** marker only — no social "seen by" — until a community server or a multi-human room makes that worth building, at which point it's an additive `read_receipts` layer on top of the same table, exactly as Matrix layered `m.read` beside `m.fully_read` rather than replacing it.

### Storage shape

One table, `read_cursors`:

- `user_id` — the stable author/account id (`AuthorRegistry`'s id for rooms; the equivalent for a session's owner), never a per-browser or per-device value.
- `thread_kind` — `'room' | 'session' | 'inbox'` (extensible). Needed because room ids, session ids, and a future inbox stream id are different id spaces from different tables; a discriminator keeps "give me every unread room" and "give me every unread session" as one indexed predicate each, rather than a query that has to guess which table a bare `thread_id` belongs to.
- `thread_id` — the room id, session id, or inbox stream id.
- `last_read_seq` — integer, monotonic, default `0`. Same semantics as `room_members.last_read_seq` today: writes that don't increase it are ignored server-side.
- `updated_at` — ISO 8601, for staleness/debugging, not for comparison (per Part 1, the comparison key stays an integer seq, never a timestamp).
- Primary key `(user_id, thread_kind, thread_id)`.

Rooms already have this exact shape living in `room_members.last_read_seq` — the honest move is to **migrate it into the unified table rather than keep two homes for the same concept** (see Migration below), both because "consistency is a feature" (AGENTS.md) and because it means the sidebar badge, the divider, the SSE broadcast, and the `CommunityAdapter` wrapper all read one code path regardless of thread kind.

Sessions get their `last_read_seq` for free: AGENTS.md's Sessions section already documents a monotonic `seq` on the durable per-session SSE stream (`GET /api/sessions/:id/events`, "snapshot → gap-free replay via `Last-Event-ID` → live events with monotonic `seq`"). That's the same kind of counter rooms already use for `room_entries.seq` — the read cursor for a session is just "the highest event `seq` this user has consumed," computed the identical way `RoomStore.countUnread` does it for rooms.

### Cross-device sync

Every write to `read_cursors` broadcasts a small `read_cursor_updated: { userId, threadKind, threadId, lastReadSeq }` event on the existing global fan-out (`eventFanOut`, the same bus `room_created`/`room_updated`/`room_activity` already ride, already consumed client-side by `useRoomListStream`). That's the one-line fix for the room gap identified in Part 2 — Slack's own model is "broadcast the write to every open connection for that user," and DorkOS already has the bus to do it on, it's just not called from `setReadCursor` today.

For a device that has the _exact same thread open_ (not just the list), also append the event to that thread's own durable stream if one exists (`/api/rooms/:id/events` for rooms; the session's own SSE stream for sessions) — this is what lets a badge clear and a divider retreat live in a second tab without a manual refetch, mirroring how Slack's realtime message server pushes the cursor to "all open connections for the calling user," not just a poll-eligible list view.

Client side: replace `use-unread-cursor.ts`'s `localStorage` read/write with a TanStack Query-backed hook shaped like the existing `useMarkRoomRead`/`useMarkRoomReadNow`, subscribed to the new broadcast event the same way `useRoomListStream` already subscribes to room events.

### Divider and badge derivation

Unchanged in spirit — both existing client patterns are already correct and should be kept, not reinvented:

- **Badge** (sidebar unread count, tab title, etc.): a strict server-computed count, `SUM(seq > last_read_seq)`, exactly as `RoomStore.countUnread` does today. `null` (not `0`) whenever the viewer has no cursor or isn't a member — the `CommunityRoomSchema.unreadCount` comment's rule ("must never render `0` ... a silent room and a room whose unread cannot be computed are different states") should become the rule for every thread kind, not just rooms.
- **"New messages" divider**: freeze the cursor value once when the thread is opened (`use-frozen-read-cursor.ts`'s pattern, generalized to any `thread_kind`) so the rule doesn't retreat out from under a reader mid-scroll, and render the shared `UnreadDivider` component at the first entry whose `seq` exceeds the frozen value. This collapses Mechanism 1 and Mechanism 2 from Part 2 into one hook and one component usage instead of two independently-invented ones.

### Migration from what exists today

1. **Rooms** — additive-then-cleanup, no product-visible change: add `read_cursors`, backfill one row per `room_members` from `(room_id, author_id, last_read_seq)` with `thread_kind='room'`, cut `RoomStore.setReadCursor`/`countUnread` and the `local-community-adapter.ts` wrapper over to the new table, add the broadcast call, then drop `room_members.last_read_seq` in a follow-up migration once verified in production. `room_members` keeps every other per-member field (`response_mode`, `joined_at`) — only the cursor moves.
2. **Agent chat sessions** — net new, but small: add a read-cursor route mirroring `PUT /api/rooms/:id/read-cursor` (`GET`/`PUT .../read-cursor` on the session resource), backed by the session's own SSE `seq`; replace `use-unread-cursor.ts`'s `localStorage` calls with the same TanStack Query mutation/query pair `useMarkRoomRead` already uses; delete the `localStorage` module once cut over — no dead code left behind per AGENTS.md's "no tolerated legacy patterns."
3. **Activity feed digest** — lowest priority, can stay as-is longer: it's a single soft "since last visit" framing, not a per-item unread claim, so it doesn't violate a–d as directly as the other two. If it should become itemized later (an "inbox" of individually-dismissable activity items), it's `thread_kind: 'inbox'` in the same table with a synthetic single stream id — no new mechanism required, just a new row shape reusing the one already built.

### What changes when a community server enters

- **Requirement (b)** is already anticipated at the type level and needs no redesign: `CommunityCapabilities.readCursor` already distinguishes `'server'` (the remote backend stores cursors and can compute a real unread count — `getReadCursor`/`setReadCursor` become calls to the community server, and the local `read_cursors` row for that room becomes a client-side cache of what the server returns) from `'client-opaque'` (the remote only supports a private per-member blob — round-trip it, but `unreadCount` must render `null`, never a number, because a server-computed count is impossible in principle, not just unbuilt) from `'none'`.
- **Requirement (d)**, per-user tracking, needs no schema change either: `read_cursors` is already keyed on `user_id`, and rooms today are already keyed on `author_id` — the only thing making DorkOS look single-user is `resolveCaller` (`apps/server/src/routes/room-caller.ts`) mapping every non-agent local caller to the one install owner under `auth.enabled=false`, which is explicitly a temporary posture (ADR `260727-184933` D6: "keeps this install single-user for good" _until_ accounts exist). Turning login on and admitting a second signed-in human produces a second `user_id` and therefore an independently-tracked cursor row automatically.
- **Social read receipts** — "who's seen this message" — should ship only once a room actually has more than one human in it, as an **additive** `read_receipts` table (`message_id, user_id, seen_at`) layered on top of the unchanged private cursor, modeled on Matrix keeping `m.fully_read` (private) and `m.read`/`m.read.private` (public/hidden) as separate primitives rather than merging them. This avoids Matrix's own retrofit problem (it shipped public-only receipts first and had to add `m.read.private` years later once the privacy cost became obvious) — DorkOS gets to design the private-first, social-later split in from the start.

### Top tradeoffs to carry into a spec

- **Seq, never timestamp**, as the cursor's comparison key — every system in Part 1 that has a real cursor uses a monotonic id, and DorkOS already has one on both rooms (`room_entries.seq`) and sessions (the SSE stream's `seq`); reaching for a timestamp anywhere would be a step backward.
- **One `read_cursors` table vs. keeping `room_members.last_read_seq` where it is.** Unification costs one migration and touches the already-shipped `CommunityAdapter` wrapper; the alternative (a new table for sessions/inbox only, rooms unchanged) is less invasive short-term but leaves two homes for the same concept, which the codebase's own consistency bar argues against.
- **Broadcast-on-write is the one-line fix that buys most of requirement (a).** It's cheap (the bus and the client subscription pattern both already exist for rooms) and should not wait for the rest of the unification to land.
- **Private marker now, social receipts later is not a compromise — it's the correct order.** Every mature system in Part 1 either started private-only (Slack, Discord's channel model) or was forced to retrofit privacy after shipping public-only (Matrix). Building receipts as an additive layer over an already-correct cursor, rather than one mechanism trying to serve both from day one, is the only ordering represented in the prior art.
