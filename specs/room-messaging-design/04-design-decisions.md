---
design-session: .dork/visual-companion/85904-1785423819
date: 2026-07-30
participants: operator (Dorian) + orchestrator
---

# Design Decisions — the room messaging experience

Operator-approved design session covering the entry action capsule, emoji reactions,
the threads surface, and micro-interactions. Every decision below was chosen by the
operator against rendered alternatives (mockup files in the session directory above).
Implementing agents build from this document; the mockups are visual reference only.

## 1. The capsule sits on the edge

**Screen:** `toolbar-position.html` · **Options:** A capsule straddling the message's
top edge · B margin-column rail · C inline meta-line whisper · **Chosen: A.**

The message toolbar is an opaque, elevated capsule that **straddles the message
block's top-right boundary — half above the block, in the gutter — and never covers
a single word of message text**. This replaces the current in-row overlay position
(whose deeper sin was occlusion, beyond the since-fixed flexbox squash). It appears
on hover or focus-within (fine pointers only; touch uses the drawer), keeps the
existing sticky-clamp behavior for messages taller than the viewport, and keeps the
shipped roving-tabindex keyboard model. Surface: `bg-popover`, border,
`shadow-elevated`, `rounded-md`.

## 2. Reactions: three quick + more, in the capsule

**Screen:** `reactions.html` · **Options:** A quick row in the capsule · B single
smiley opening a strip · **Chosen: A** (operator overrode the orchestrator's B lean).

The capsule's leftmost tenants are the person's **three most-used emoji** (defaults
until usage exists: 👍 ❤️ 🎉), then a **🙂+ button opening the full picker**
(frequents + search), then a divider, then reply / copy / mention. One hover, one
click to thank an agent.

**All five pill behaviors approved:**

1. **Your reaction glows** — the pill you added carries the accent border; clicking
   it again removes it (the pill is the toggle).
2. **Hover names names** — "You and LifeOS reacted 👍", names not counts.
3. **The pop** — arrival animates (see §5); removal is a plain fade.
4. **The ghost +** — once a message has any reaction, a faint 🙂+ pill ends the row.
   Zero-reaction messages stay perfectly clean.
5. **A reaction reaches the agent, quietly** — the DorkOS twist. A person's reaction
   on an agent's entry lands in that agent's room context as a **costless
   acknowledgment**: no turn, no trigger, no cascade entry, no reply. Etiquette
   gains the matching rule: an agent never replies to a reaction. (Agents _sending_
   reactions remains a separate, still-gated decision — nothing here builds it.)

## 3. Threads: the side panel

**Screen:** `threads-surface.html` · **Options:** A inline polished · B side panel ·
C hybrid preview+panel · **Chosen: B** (over the orchestrator's C lean).

**The inline thread gathering is retired.** In the room timeline, a thread root
shows a quiet **"↳ N replies · last 9:45 AM" row**; clicking opens the thread in a
**side panel** beside the room with its own composer (reply-in-thread re-aims
there). The room scroll stays clean regardless of thread length. On mobile the
panel is a **full-screen push with a back gesture**. One idiom, not two.

**Cross-room surface (all three approved; the fourth deferred):**

1. **A "Threads" sidebar item** — every thread the person started or replied in,
   most-recent first, with unread counts. v1 derives membership purely from
   participation (no new schema). _Follow/unfollow was assessed as real server lift
   (persisted preference, new table) and deferred until threads are noisy enough to
   need the valve._
2. **Presence follows you into threads** — the working line renders inside the
   panel when the live claim's `entryId` belongs to that thread.
3. **Unread counts on thread roots** — the "↳ N replies" row renders in accent with
   a count when replies exist beyond the room's read cursor (derivable from
   `last_read_seq` vs reply seqs; no new schema).

## 4. States (designed, not discovered)

Failed reply: words return, aim respected (shipped). Orphaned thread: panel says
the start is gone, replies stay. Reactions on a deleted message die with it. 10+
reactions wrap, then "+N more". Offline/stalled: reactions disable with the
composer; presence clears (shipped). Empty thread panel: root + composer, no fake
state. Solo rooms behave identically — agents are first-class.

## 5. Micro-interactions — the v2 spring set

**Screens:** `micro-interactions.html` → `micro-interactions-v2.html` · Operator
verdict on v1: "snappier and more personality" · **v2 approved in full.**

All motion: transform/opacity only, springs with real overshoot, everything
resolving under 300ms. Approximate curves as demoed (implementers may tune ±10%
against the live playground bench, nothing more):

1. **Capsule entrance** — 90ms fade + 5px rise with a ~1px overshoot settle
   (`cubic-bezier(.2,1.4,.4,1)`). Exit: faster plain fade.
2. **Reaction pop** — scale 0.4 → 1.28 with ~2° tilt, settle to 1
   (`cubic-bezier(.2,1.8,.35,1)`), plus a one-shot accent **ring burst** expanding
   outward. Count increments roll. Removal fades.
3. **Thread line draws** — connector extends downward ~140ms; the arriving reply
   lands with a 2px bounce.
4. **Presence hand-off** — "working…" cross-fades out as the reply settles
   **upward** 4px into place; the indicator visibly becomes the answer.
5. **Reply-row count flip** — on increment, the count flips up 3px with a scale
   snap and one accent flash, then returns to muted.
6. **Press acknowledgment (touch)** — long-press-in-progress scales the message to
   0.95 with a spring-back overshoot on release or cancel.

## Build order (dependency-aware)

1. **B1 — capsule reposition + entrance** (client-only; after the enclosure fix
   lands): straddle position, v2 entrance, bench sections updated. No reactions yet
   — the leftmost slot stays structurally reserved.
2. **B2 — reactions server**: storage keyed to entries, routes, SSE fan-out,
   frequents tracking, the agent-context acknowledgment (§2.5), etiquette line.
3. **B3 — reactions client**: capsule quick row + picker, pills with all five
   behaviors, pop + ring, mobile drawer row. Depends on B1 + B2.
4. **B4 — thread panel**: retire inline gathering; reply rows with unread accent +
   count flip; the panel with composer + thread-scoped presence; mobile push.
   Shares the room-view surface with B1/B3 — sequence, never parallel.
5. **B5 — Threads sidebar view**: participation-derived aggregation with unreads.
   Server: one aggregation query/route. Client: sidebar item + view. After B4.

Micro-interactions ship inside their host builds (1 with B1; 2 with B3; 3/4/5 with
B4; 6 with B3's drawer touches), never as a separate pass.
