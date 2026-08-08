---
id: 260808-140956
title: Read state is one broadcast server-side cursor per user and thread
status: draft
created: 2026-08-08
spec: team-room-home
superseded-by: null
amends: null
---

# 260808-140956. Read state is one broadcast server-side cursor per user and thread

## Status

Draft (extracted from spec: team-room-home)

## Context

"New messages" state is currently two disagreeing mechanisms: chat sessions keep a per-browser
localStorage watermark that never touches the server, and rooms keep a server-side
`room_members.last_read_seq` whose writes are never broadcast, so a second device catches up
only by a ~30s poll. Neither is per-user-syncable, and a future community server must know
which users have seen which messages. Industry prior art (Slack, Discord, Telegram, Matrix)
converges on monotonic position cursors, not timestamps or per-message receipts.

## Decision

We will store read state as one `read_cursors` table — `(user_id, thread_kind, thread_id) →
last_read_seq` — serving rooms, DMs, agent sessions, and inbox items, with every cursor write
broadcast on the existing `eventFanOut` bus so all devices update on push. Cursors are private
markers; social "seen by" receipts are a later additive layer (Matrix's `m.fully_read` vs
`m.read` split), added only when rooms have multiple humans. The agent-side RP3 cursor stays on
the room-membership row; this table is user-side. The `CommunityAdapter`
`getReadCursor`/`setReadCursor` seam wraps this table for the local backend.

## Consequences

### Positive

- One divider mechanism everywhere; cross-device sync by push, not poll.
- Per-user by construction — multi-human rooms and community servers get correct state free.
- O(1) storage per (user, thread), matching every studied system's default.

### Negative

- A migration moves rooms off `room_members.last_read_seq` for humans while agents keep using
  it — two cursor homes with a documented boundary.
- Sessions need their SSE `seq` treated as a stable read anchor, a new implicit contract.
