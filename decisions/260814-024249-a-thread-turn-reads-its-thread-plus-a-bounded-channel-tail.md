---
id: 260814-024249
title: A thread turn reads its thread, plus a bounded channel tail
status: accepted
created: 2026-08-14
spec: room-participation
supersedes: null
amends: null
superseded-by: null
---

# 260814-024249. A thread turn reads its thread, plus a bounded channel tail

## Status

Accepted — implemented in `room-context.ts`, `room-store.ts` and
`runtimes/shared/room-context-block.ts` (DOR-1207).

It refines the ambient window of `specs/room-participation/02-specification.md` §8.3 and stands on
[260728-022013](260728-022013-a-thread-is-a-relation-between-entries.md) — a thread is a set of
entries inside a channel, so the question "what is the scope of a reply?" is answerable per
mechanism rather than settled by a container.

## Context

Three mechanisms answer that question, and until now two of them said "the thread" and the third
said "the channel."

- **The engaged window is thread-scoped.** `engagementFor` takes a `threadRootEntryId` and
  `listRecentPostsByOthers` filters on it, because "being addressed inside a thread must not engage
  an agent across the whole channel, and the reverse" (spec §3.2).
- **Reply routing is thread-scoped.** A turn triggered inside a thread posts back into that thread,
  and the rendered block tells the agent so in as many words: "posted as a reply in that thread, not
  into the main flow of #build."
- **What the agent was told it had missed was ROOM-scoped.** `buildRoomContext` read the unread
  window off the whole room with no thread predicate. So an agent mentioned inside a thread was
  engaged there, answered there, and arrived holding up to thirty channel-wide messages plus a
  200-character excerpt of the thread it was actually in.

That is not a cosmetic mismatch. The window is the largest thing in the block, so the conversation
the agent is answering was outnumbered by a conversation it is not in — and answering the wrong one
in a thread is worse than answering it in a channel, because nobody in the thread asked.

The obvious fix, thread-scoping the window, has an obvious cost: an agent that can see nothing but
its own aside will confidently re-raise something the channel settled two minutes ago. And a read
cursor cannot give that awareness back, because an agent already up to date on the channel has
nothing unread there to be shown.

## Decision

**When the triggering entry is inside a thread, the ambient window is that thread's, and a small
bounded tail of the channel rides beside it.**

- `pending` is scoped to the thread's replies — same read-cursor and joined-at floors, same
  `rooms.ambientMaxEntries` cap, same `pendingTruncated` semantics as a top-level turn. The scope
  changes; the bound does not.
- **`channelTail`** carries at most **5** top-level channel POSTS, oldest-first, frozen at the
  triggering entry's `seq`. It is a new optional field on `RoomContextData` — additive, absent for a
  top-level turn, so no existing consumer changes. Posts only: the whole read is five rows, and one
  machine notice would eat a fifth of an agent's entire awareness of the channel.
- **The tail is filled with UNREAD top-level messages first**, falling back to the newest few when
  nothing there is unread. What did not fit is counted in **`channelTailOmitted`** and stated in the
  rendered block ("3 older channel messages you have not read were not shown here"). The reason is
  in Consequences: the room has one read cursor, and a thread turn advances it past channel messages
  it never showed.
- Both reads carry the §8.3 **joined-at floor** — the unread read starts at
  `max(lastReadSeq, joinedSeq)`, the fallback at `joinedSeq` — so background is not an exemption
  from "a member does not retroactively read what was said before they joined".
- The tail is deliberately not governed by `ambientMaxEntries`. That cap sizes the conversation
  being answered; this is the glance sideways.
- **Nothing is counted twice.** A thread reply is never top-level, so `pending` and `channelTail`
  are disjoint by construction, and the entry the thread hangs off is excluded from the tail because
  it is already quoted as the thread's opener.
- **A top-level turn is unchanged**: the whole room, thread replies included, and no tail — the
  channel IS its scope, so there is no "rest of the room" to name.
- The tail renders **inside the untrusted fence**, under a heading that says it is background and
  not the thread. It is other members' text, so region membership follows what the value is
  (`.claude/rules/room-conduct.md`), and the label is what stops a channel message reading as part
  of the aside.
- **That heading carries the turn's fence nonce** (`--- <nonce> RECENT IN THE MAIN CHANNEL ---`).
  It is not decoration: it tells the model everything under it is background it need not answer, so
  a plain literal would be typeable — a member pastes the line into a message and every genuine
  thread message after it is relabelled as ignorable channel noise. The tail is always last inside
  the fence, so this marker opens a region the fence's own END marker closes.

## Consequences

### Positive

- One scope, three mechanisms. Whether an agent keeps listening, what it reads, and where its answer
  lands are now the same answer, so an agent answering in a thread answers the thread.
- A thread turn's window is smaller and denser: the messages in it are about the thing being asked
  about, rather than thirty lines of channel to filter first.
- The tail is five lines, so the channel awareness costs about a tenth of what the room-scoped window
  did while still keeping an agent from repeating what the room just settled.
- The thread window reads `idx_room_entries_thread_root` (whose third column is `seq`, migration
  0040), so scoping the window costs a page rather than a scan.

### Negative

- **A thread turn still advances the ROOM's read cursor past channel messages it did not show, and
  those messages are then unread nowhere.** This is the sharpest consequence and it is accepted
  rather than solved. The claim advances one cursor for the whole room to the triggering entry's
  `seq` (`room-trigger.ts`), because there is exactly one `(member, room)` cursor — ADR
  260728-022013 gave up the per-thread cursor deliberately, and getting one back is a schema
  decision, not a line in this builder. Scoping `pending` to the thread therefore turns "the agent
  reads it later" into "nobody reads it": a top-level message below the trigger's `seq` is behind
  the cursor from the moment the claim lands, whether or not this turn rendered it.

  Two things bound and disclose the loss, and neither pretends to remove it. The tail is filled
  with the UNREAD top-level messages first, so what the glance spends itself on is exactly what is
  about to become invisible. And what did not fit is COUNTED — `channelTailOmitted`, rendered as a
  line inside the block — so the agent is told "3 older channel messages you have not read were not
  shown", which is something it can act on by asking, rather than a silence indistinguishable from
  a quiet channel. Before this, five unread channel messages under a thread mention were consumed
  with `pendingTruncated: false` and no trace anywhere.

  The real fix is a per-scope read cursor, and whoever picks that up should read this paragraph
  first: the alternatives considered and rejected here were advancing the cursor only to the
  thread's own entries (which replays the channel forever, because the cursor never moves past it)
  and rewinding it after a thread turn (which replays the thread too, and races the next claim).

- **A thread turn can now miss channel context it used to get.** Six top-level messages ago is
  invisible to it. That is the trade: the tail is background, not history, and an agent that needs
  more has to be asked in the channel.
- **A room configured to replay nothing (`ambientMaxEntries: 0`) still gets the five-line glance.**
  The tail is deliberately not governed by that cap, so the operator's "no history here" setting is
  honoured for the conversation and not for the sideways look. Left as it is because the tail's job
  is the disclosure above, which a zero cap does not make less true; if it ever reads as a
  contradiction, gating the tail on `cap > 0` is a one-line change and a real decision to record.
- **`pending` no longer means one thing.** It means "the unread window of whatever scope this turn is
  in", which a reader has to learn once. The alternative — a second field for thread pending — would
  have made every consumer branch on the thread pointer to find the window.
- **The tail is a second read per thread turn, and a third when it is full.** Its predicate,
  `thread_root_entry_id IS NULL`, is a residual filter over the `(room_id, seq)` primary key walked
  backwards — not an index seek, because the partial index covers the non-null rows only. So it
  reads the rows between the trigger and the fifth qualifying top-level post: five rows in a
  channel, and ~30k inside a 30k-reply thread (~0.5µs/row, so ~15ms). Once per THREAD turn, beside
  a model call. No second index is being added for it; if a room ever makes that measurable, the
  fix is an index on `(room_id, seq) WHERE thread_root_entry_id IS NULL`, not a smaller glance. The
  count query runs only when the page came back full. None of it takes a model turn, which is the
  property `meta/agent-etiquette.md` E7 actually protects.
- **Five is a judgement, not a measurement.** It is sized like `OWN_RECENT_MAX_ENTRIES` because it is
  the same kind of thing — a handful of lines that stop an agent being wrong — and it will need
  revisiting the first time a busy channel makes a five-line glance useless.
