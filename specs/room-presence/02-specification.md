---
slug: room-presence
id: 260729-145341
created: 2026-07-29
status: specified
---

# Specification: Room presence — an honest working indicator, from claim to release

- **Slug:** room-presence
- **Id:** 260729-145341
- **Status:** specified
- **Date:** 2026-07-29
- **Author:** Tansy (directed by Dorian), SPECIFY stage
- **North Star:** [`meta/agent-etiquette.md`](../../meta/agent-etiquette.md) — E7, E15, E16 bind everything here.
- **Parent programme:** this is **RP9 of `specs/room-participation/02-specification.md` (§11.1), realised and extended** — not a parallel invention. §2 states exactly what is RP9 verbatim and what this spec adds on top.
- **Anchor:** `origin/main` @ `c70de1389`, 2026-07-29. Every `file:line` below was read at that commit on this branch. Where a number differs from `01-ideation.md`'s survey source, the ideation §3 records the drift.

Read [`01-ideation.md`](./01-ideation.md) first: its §3 is the verified codebase map and its §5 holds the nine operator decisions this spec implements without reopening.

---

## Overview

Between a person's post in a room and the agent's reply, the room shows nothing. The knowledge exists — the dispatcher claims each target before its turn runs and holds a live per-agent claim map — and is currently shown only to other agents (`room_context.working`), never to the person waiting. This spec publishes that fact on the already-shipped ephemeral signal channel, renders it as a presence line in the cockpit, keeps it honest across slow turns and failures, and maps it to each connected platform's native idiom.

One sentence of design: **presence is the claim map, made visible.**

## Background / Problem Statement

The operator's scenario: post a question in a channel, and until the answer lands (up to 10 minutes of sanctioned wait, up to 60 at the ceiling) the room is indistinguishable from a room where nothing is happening. Three concrete dishonesties today:

1. **Dead air.** The claim exists from the moment of the triggering post (`room-trigger.ts:451–463`), the signal channel exists (`room-schemas.ts:534–541`, `room-service.ts:716–723`), and nothing connects them: `publishSignal` has zero **production** call sites (one test exercises the channel end to end — `apps/server/src/routes/__tests__/rooms-events.test.ts:291` — and moves with §3.2's signature change) and the client drops signals unread (`use-room-stream.ts:157`).
2. **The slow-turn vanish.** A turn that outruns the 10-minute wait loses its claim at the deadline while it keeps running (`room-trigger.ts:554`, `room-turn-runner.ts:224`); for up to 50 minutes (ceiling 60 − wait 10, both from `config-schema.ts:686,698` defaults) the agent looks idle everywhere — including to other agents via `room_context.working` — and then a late answer appears from nowhere.
3. **The Telegram fake.** The one presence indicator we do ship starts at inbound publish, before any turn is claimed, and blind-caps at 60 s (`telegram-adapter.ts:457–465`, `outbound.ts:37,40`). It can show typing for an agent that never runs. E16 ("show a working indicator when actually working") forbids exactly this shape.

## Goals

- A person in a room sees, within a second of posting, which agents are on it — and for how long, and whether it is taking longer than usual.
- The indicator is **mechanically honest**: it exists iff a claim exists; it survives exactly as long as the work; a crashed server cannot strand it.
- Terminal honesty is preserved: every path that releases the indicator still ends in a durable entry or notice, with one stated exception (§4.3).
- Platform surfaces (Telegram, Slack, Buzz) express the same lifecycle in their native idiom, replacing the current dishonest or absent indicators.
- The community port can carry presence outward without a new capability flag or a weakened conformance suite.

## Non-Goals

- **Read receipts, seen-by lists, or any exposure of read state** — agents have no advancing read cursor to receipt from (nothing calls `setReadCursor` for agents; `room-participation` §8.1), the obligation literature is unambiguous, and Buzz's own NIP-RS spec text ("clients that expose read activity to other users MUST require explicit user consent") is the right stance. If read receipts are ever proposed, they are a new spec with a consent design, not an extension of this one.
- **Model-chosen acknowledgments.** No tool lets an agent emit or suppress presence. E11 already bans standalone acknowledgment messages; a model-facing ack channel would reintroduce them one layer down.
- **Queue state.** There is no queue (`01-ideation.md` §3.6) and the `agent_busy` notice's deliberate vagueness — no what, no where, no for-whom — is a leak-free property this spec keeps. The presence line never says "busy elsewhere".
- **Streaming partial reply text into rooms**, arbitration, or any behavior change to who runs a turn.
- **Human typing indicators**, and any UI that mixes agent presence into a human is-typing affordance (§5.2).
- **Reactions as a room feature** (attach point stays reserved, `specs/rooms/02-specification.md:108`).

## Technical Dependencies

None new. Everything rides shipped machinery: the room SSE stream and its no-replay signal framing (`room-events-handler.ts:108–120`), `SignalTypeSchema` (`relay-envelope-schemas.ts:20–22`), the global event fan-out (`room-service.ts:864–871` is the sibling precedent), the claim map (`room-trigger.ts:220`), grammY's `sendChatAction`, Slack's `reactions.*`/`assistant.threads.setStatus`, and — for phase 3 — the CommunityAdapter port as amended.

---

## 1. Vocabulary and one rule

The signal type is **`progress`**, reused from `SignalTypeSchema` as RP9 designates (`room-participation:682`) and as the rooms spec requires ("reuse `SignalTypeSchema`… rather than declaring new names", `specs/rooms/02-specification.md:229`). `typing` is deliberately not used on the rooms path: **agents do not type — they work**. `typing` remains the relay adapters' wire word where a platform's API demands it (Telegram's `sendChatAction('typing')` is the platform's only vocabulary); inside DorkOS the state is always "working".

The one rule, stated once and tested everywhere: **a presence signal is published only by the dispatcher's claim lifecycle.** Not by a route, not by a tool, not by the model, not by an adapter inventing its own. Every publisher below is a consequence of a claim transition.

## 2. Position against RP9 — what is realisation, what is extension

RP9 (`room-participation` §11.1, :674–688) specified: dispatcher publishes `progress` on claim and on release; client renders a lightweight presence line under the composer, never as a message; E16 binds it. RP9 is listed with no dependencies, parallel-runnable (:723, :726). This spec **is** that work item, plus the following extensions RP9 did not carry:

| Piece                                                                   | Status vs RP9                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `progress` on claim + release; presence line under composer             | RP9 verbatim (§3, §5 here give it a wire shape and a rendering contract)                                                                                                                                                                                                          |
| Signal payload (`state`, `entryId`, `since`) on `RoomSignalEventSchema` | Extension — RP9 named no payload; the bare schema cannot carry "since when" or "which question"                                                                                                                                                                                   |
| Claim survives the wait deadline; `working_late` state                  | Extension — fixes a gap RP9 inherited from the shipped claim lifecycle (`01-ideation.md` §3.2)                                                                                                                                                                                    |
| `entryId` + `sessionId` on `ActiveClaim`                                | Extension — also serves RP9's "work one click away" for **in-flight** turns (:686 covers only posted replies via `room_entries.sessionId`)                                                                                                                                        |
| Republish + client TTL (the drop-guard)                                 | Extension — RP9 gestured at Buzz's drop-guard (:683); this is the concrete mechanism                                                                                                                                                                                              |
| Sidebar working-dot (`room_presence` global event)                      | Extension — new global name, both-ends rule applies                                                                                                                                                                                                                               |
| Telegram/Slack/Buzz mappings; CommunityAdapter payload                  | Extension — RP9 was cockpit-only                                                                                                                                                                                                                                                  |
| Etiquette amendment                                                     | Extension — closes the standard-lags-mechanism gap                                                                                                                                                                                                                                |
| Long-post collapse; session link on **posted** entries                  | **Stays RP9's / the client's** — not moved here. `room_entries.sessionId` is already stored; the collapse is a message-list concern with no presence dependency. When RP9's ticket is filed, its remaining scope is exactly these two items plus adopting this spec for the rest. |

**Effect on the room-participation phase table (§12 there):** RP9's row is realised by this spec (its ticket should reference this document); no other row changes. RP6's future `post_to_room` interacts with §4.3's accepted cost and is noted there. This spec does not depend on RP1–RP8 and none of them depend on it.

## 3. Server: the claim is the signal

### 3.1 Two fields and one lifetime fix on `ActiveClaim`

`ActiveClaim` (`room-trigger.ts:780–787`) gains:

```ts
interface ActiveClaim {
  roomId: string;
  cascadeRoot: string;
  authorId: string;
  depth: number;
  claimedAt: string;
  /** The entry whose trigger this claim answers — the presence signal's key. */
  entryId: string;
  /** The (room, agent) session the turn runs on — bound at claim time. */
  sessionId: string;
  /** True once the room stopped waiting; the turn is still running. */
  pastDeadline: boolean;
}
```

`entryId` and `sessionId` are both in hand at the `claimed.set` call site (`entry.id` and `target.sessionId`, resolved at :451–457). `cascadeRoot` was never a substitute for `entryId`: they coincide only at depth 0.

**The lifetime fix.** Today the claim dies in `runOne`'s `finally` when `runner.run()` resolves (:554) — which for a slow turn is the wait deadline, not the turn's end (`room-turn-runner.ts:224`). New rule: **a claim lives until its turn reaches a terminal.** When `result.late` is set, `runOne` marks the claim `pastDeadline: true` instead of deleting it, and `deliverLate` (:615) deletes it when the `afterDeadline` promise settles — both fulfilment (the late post or the `turn_failed` notice, via `deliver`) and rejection (the `.catch` infra path). The non-late path keeps today's `finally`.

Two knock-on effects, both improvements and both tested:

- `workingIn` (:758–766) now reports late-running turns, so `room_context.working` stops understating for **agents** as well as humans — the exact gap `deliverLate`'s doc comment records (:609–611).
- `claimsIn` (:768–775), which the cascade guard unions with the durable ancestry query, now holds the claim longer. This is a strengthening of the same kind as the thread-boundary fix in `room-participation` §3.4: an author with a late turn in flight is in the cascade. For a late turn that eventually **posts**, nothing is newly refused that today's code would have allowed-then-recorded — the late reply carries the same cascade stamp when it lands, so the durable ancestry catches up to what the held claim asserted early. **The one genuinely new refusal is the silent late turn**: a late turn that ends with nothing durable never lands its stamp in the ancestry table, so a re-trigger of that author in the same cascade during the held-claim window is refused where today it would run a second turn. Accepted, and deliberately: the author really does have a turn in flight on that same `(room, agent)` session, and starting a second one is the busy-collision RP8's steer exists to avoid. It produces one surface collision worth naming — the refusal's `cascade_stopped` notice ("this back-and-forth hit its automatic-reply limit", `room-notices.ts:35`) lands while the presence line still says the agent is working. The two are both true (no _new_ turn starts; the _old_ one is still running) but the notice copy talks about limits when the cause is an in-flight turn, so the test below pins the coexistence and the DECOMPOSE task carries a note to revisit the copy if dogfooding shows it read as a contradiction. A test pins both halves: the existing cascade scenarios gain no refusals, and the silent-late-turn re-trigger is refused exactly once with the indicator unaffected.

Claims stay **memory-only**. A restart forgets them; §3.3's republish stopping + §5.3's TTL is the cleanup, exactly Buzz's crash story (harness dies → republish stops → client TTL clears in seconds).

### 3.2 The wire shape

`RoomSignalEventSchema` (`room-schemas.ts:534–541`) gains three optional fields; the discriminated union (`RoomEventSchema`, :544–546) and the no-`id:` framing are untouched, so replay semantics cannot regress by construction:

```ts
export const RoomSignalEventSchema = z
  .object({
    type: z.literal('signal'),
    signal: SignalTypeSchema,
    authorId: z.string().min(1),
    at: z.string(),
    /** Presence lifecycle, present when `signal === 'progress'` from the rooms path. */
    state: z.enum(['working', 'working_late', 'done']).optional(),
    /** The triggering entry — with (roomId, authorId) this keys the indicator. */
    entryId: z.string().optional(),
    /** When the claim was taken. The client derives elapsed time from this. */
    since: z.string().optional(),
  })
  .openapi('RoomSignalEvent');
```

Grain: **one logical indicator per `(room, agent, entryId)`** — the claim map's own grain, `(roomId, cascadeRoot, authorId)`, projected through the claim's stored `entryId`. `since` rides every publish so a subscriber that missed the original claim (cold connect, reconnect) can still render "working for 4m" — signals never replay, so every publish must be self-contained.

`RoomService.publishSignal` (:716–723) widens to pass the payload through. It stays the single seam the SSE broadcaster sees; its signature change is additive.

### 3.3 The publisher: five moments, one loop

All in `RoomTriggerDispatcher` (`room-trigger.ts`), which owns the claim map. The dispatcher's deps gain a `publishSignal` callback wired from `RoomService` at construction (the service already constructs the dispatcher's deps; no circular import).

| Moment                                                        | Publishes                                     |
| ------------------------------------------------------------- | --------------------------------------------- |
| Claim taken (`claimTargets`, after `claimed.set`, :457–463)   | `working`, per claimed target                 |
| Wait deadline (`runOne` sees `result.late`)                   | `working_late`, once, and the claim is marked |
| Terminal: reply posted (`deliver` posts)                      | `done`                                        |
| Terminal: notice written (`reportSilence` — busy/failed)      | `done`                                        |
| Terminal: turn closed with nothing to say (`deliver` returns) | `done`                                        |
| Late terminal (`deliverLate` settles, either way)             | `done`                                        |

Plus the **republish loop**: a dispatcher-owned interval re-publishes the current state (`working` or `working_late`) for every live claim every `PRESENCE_REPUBLISH_MS` (10 000 ms — ours, unsourced; see §10). The loop starts when the map becomes non-empty and stops when it empties, so an idle server runs no timer. The loop is the cold-connect story (a client opening a room mid-turn sees presence within ≤10 s) and half of the drop-guard (§5.3 is the other half). Publishing walks the same map `workingIn` walks; it runs no model and costs no turn — E7 holds by the same argument as `room_context.working` (`room-trigger.ts:516–519`).

Ordering note: the `done` publish is issued **after** the durable write it accompanies (`writer.post` / `postNotice` return), so a client never sees the indicator drop before the entry that explains it is on the stream.

One change inside `deliverLate` itself: its `.catch` (:634–640) — the path where the late `deliver` **throws** rather than resolving — today writes only a `logger.warn`. It gains a best-effort `reportSilence(…, 'failed')` before the claim delete and the `done`, so an infra failure during late delivery leaves the same damped `turn_failed` notice every other failure leaves. The residual case (that notice write itself failing) collapses into §4.1's path (b).

Forward note for RP8: when `room-participation` §10.4's halt verb lands, it "interrupts every in-flight turn … and drops every pending claim" — every claim it drops must release through this same seam, publishing `done` alongside the halt's own durable notice. The halt becomes a sixth publisher moment, not a bypass; recorded here so RP8's implementer inherits the invariant instead of rediscovering it.

### 3.4 What the busy path shows

Nothing changes. A busy refusal never held a claim past `claimTargets` — the claim is taken, the turn is attempted, the lock refuses, `reportSilence` writes the damped `agent_busy` notice, and the indicator that existed for that attempt releases with `done`. The person sees: indicator appears, indicator resolves into the busy notice. The notice's vague copy (`room-notices.ts:80`) is untouched; the signal carries no reason field at all, so there is nothing to leak.

## 4. Failure honesty

### 4.1 The terminal inventory, re-stated with signals

`01-ideation.md` §3.5's table is the ground truth. With this spec, every row gains "and the indicator releases at the same moment", and no row loses its durable artifact. The invariant, which extends `.claude/rules/room-conduct.md`'s "a refusal is visible":

> **An indicator may only disappear into one of: a post, a fresh notice, a notice already standing under the damping key, or a named exception below.** A release with no durable explanation — new or standing — is a defect.

"Already standing" is load-bearing, because the shipped code has three release paths that write nothing _new_, and a spec that says "exactly one exception" while keeping them mandates defects. Named, with why each is kept:

- **(a) The damped repeat.** `reportSilence` early-returns while the `(room, agent)` silence key is armed (`room-trigger.ts:663`) — a second busy or failed turn before the agent's next successful answer writes nothing. Kept: the standing notice **is** the durable explanation ("Kai was busy… send it again"), still on the log, still true; re-noticing every repeat is the four-apologies spray the damping key exists to prevent (its own doc comment, :645–652). The indicator releases into a notice already on the record. This also bounds §Background's late-failure claim: a late failure is durable **once per `(room, agent)` until recovery**, not once per failure.
- **(b) The archived-room race.** `writeNotice` catches and returns `false` when the notice write itself fails — its comment names the room being archived between post and notice as the reachable case (:716–727). Kept: an archived room has no presence line and no audience; the failure is operator-visible in the server log, and a retry loop against an archived room would be effort spent on a room nobody can read.
- **(c) The late delivery that throws** (`deliverLate`'s `.catch`, :634–640) — up to 50 minutes of `working_late`, then release with only a log line. **Not kept**: §3.3 closes it with a best-effort `reportSilence('failed')` on that path, reducing (c) to (a) on repeat and to (b) when the notice write also fails.

The remaining exception — the turn that ran and deliberately said nothing — is §4.3's, and it is the only one that is a _choice_ rather than an accounting edge.

### 4.2 The crash cases

- **Server process dies mid-turn:** claims are memory-only, republish stops, every open client clears the indicator at TTL (≤30 s). The turn itself is gone too (it was in-process), and today's behavior already leaves no notice for a process crash — presence does not regress that; it merely stops _claiming_ work that no longer exists, faster than the person would otherwise learn it.
- **Client disconnects and reconnects:** signals were never in replay; the republish loop repaints within ≤10 s. The stalled-stream banner (`ChannelsPage.tsx:123`) takes precedence over the presence line — a stream we cannot read is a stream whose presence we must not claim to know (§5.4).

### 4.3 The accepted cost, stated plainly

An agent that runs a turn and deliberately says nothing (deliver's "exercising judgment" branch, `room-trigger.ts:585–588`) will now have shown _working… → gone_ with no durable trace — the one indicator-then-nothing this design accepts **as a choice** (§4.1's paths (a) and (b) are accounting edges; this one is policy). It is accepted because the alternative is worse on both sides: forcing a durable "had nothing to say" entry on every ambient turn is the over-participation failure this whole programme exists to prevent, and suppressing the indicator for turns that _might_ end silent would require knowing the future. The literature's "three-dot anxiety" finding is about _addressed_ questions hanging; the addressed half of this hole is closed separately by RP6's `agent_declined` notice (`room-participation` §10.2.2), at which point the remaining silent case is exactly the sanctioned ambient one. Until RP6 lands, an addressed turn that ends silent shows the same working→gone — a temporary widening of the accepted cost, named here so nobody discovers it as a bug.

## 5. Client: the presence line

### 5.1 Placement and rendering

One presence line in the room view, **under the composer** (RP9's words, :683), rendered by a new `RoomPresenceLine` in `widgets/room-view/ui/`, fed by a `usePresence` model hook in `entities/room` that replaces the drop at `use-room-stream.ts:157` with a small keyed store (`(authorId, entryId) → {state, since, lastSeenAt}`). FSD: the store and hook live in `entities/room` and export through its barrel; the widget composes them.

Rendering states, copy per `writing-for-humans` (plain, no jargon, no theatrics):

| Situation                 | Line                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| One agent, `working`      | `Kai is working on it · 42s`                                                                     |
| One agent, `working_late` | `Kai is still working — this is taking longer than usual · 12m`                                  |
| Two or three agents       | `Kai and Ana are working on it · 42s` (oldest `since` shown)                                     |
| More than three           | `4 agents are working on it` — expands on click/tap to the names, each with its own elapsed time |
| None                      | The line is absent. No reserved empty space, no placeholder.                                     |

Elapsed time derives from `since` client-side and ticks locally; no per-second signals exist. The threshold "more than three" follows the platform convention (collapse past ~3 — community-reported, unverified; see §10) and is a rendering constant, not config.

Two store rules the wire shape does not state on its own:

- **The store keys `(authorId, entryId)`; the line counts distinct authors.** One agent claimed by two triggering entries in the same room (two cascades in flight) is two store entries and **one** name on the line, shown with the older `since` — a person cares that Kai is working, not how many claims the dispatcher is holding.
- **A post by an author clears that author's indicators in the room.** When an entry authored by X arrives on the stream, every `(X, *)` store entry for that room is dropped, whatever its state. This closes the reconnect-after-reply lie: a client that reconnects, replays the reply (durable, so it replays), and then never sees the pre-disconnect `done` (ephemeral, so it does not) would otherwise show "working" under an answer that is already on screen. Keyed on the **author**, deliberately not on which entry the reply answers — nothing durable links a reply to its trigger today (`answersEntryId` is `room-participation` §5.3's, unshipped; zero hits in the tree), and the author-level clear is correct anyway: whatever X was working on, X's latest word is now on the log, and if a second claim is genuinely still live the ≤10 s republish restores its line.

### 5.2 Agents work; nothing here types

The affordance is agent-specific by design, not just by current absence of human typing: the copy always says _working_, the component is named for presence rather than typing, and if a human typing indicator ever ships it gets its own separate row — Buzz's split (`useChannelActivityTyping` routing agents away from the human "is typing…" row into a collapsed activity bar) is the pattern, adopted here **before** the collision can happen rather than after.

### 5.3 The TTL — the client half of the drop-guard

Every stored indicator expires `PRESENCE_TTL_MS` (30 000 ms — 3× the republish interval, Buzz's own flap rationale: their Redis TTL is 3× the heartbeat; ours, unsourced beyond that analogy, §10) after its `lastSeenAt`, pruned on a coarse interval. A `done` clears immediately. So the worst-case stranded indicator after any server-side failure is 30 s — within the "short TTLs bound the dishonesty window" band the platform survey documents (Telegram ≤5 s, Discord 10 s, Slack status 2 min).

### 5.4 Interplay with the stalled stream

When `stream.stalled` is set (`use-room-stream.ts` state, banner at `ChannelsPage.tsx:123`), the presence store is cleared and the line hidden: a client that cannot read the stream does not know who is working, and showing a frozen "· 42s" would be the lingering-dots failure. On recovery, the republish loop repaints within ≤10 s.

## 6. Sidebar: the `room_presence` global event

The brief sketched the sidebar dot riding `room_activity`. **It cannot**: `room_activity` broadcasts only on committed entries and its payload is `{roomId, seq, lastActivityAt}` (`room-service.ts:864–871`) — a claim-time emission has no `seq` to carry and would corrupt the event's meaning for its existing consumer (`use-room-list-stream.ts:23`). So: a **new global event, `room_presence`**, payload `{ roomId: string, working: number }`, broadcast by the dispatcher's claim transitions (count changes only, plus one re-broadcast per republish tick while non-zero — the global stream has no replay, so late subscribers need the repaint too).

The both-ends rule applies in full (`specs/rooms/02-specification.md:218`): the name lands in `GENERIC_EVENTS` (`stream-manager.ts:153+`) as a string literal in the same PR that adds the broadcast, and `sse-event-allowlist.test.ts` proves it. Client: `use-room-list-stream.ts` maps it to a working-dot on the room row — a small pulsing dot with `aria-label` "N agents working", distinct from the unread marker, cleared by count 0 or the same 30 s TTL. `GET /api/rooms` additionally gains an optional `working` count per room (derived from the claim map at read time) so a fresh page load does not wait a republish tick for its dots.

## 7. Adapters: the same lifecycle in native idiom

These land in phase 2 (Telegram) and phase 3 (Slack, Buzz). The rule of §1 holds across all of them: the platform indicator is driven by the claim lifecycle, never by message receipt.

### 7.1 Telegram — replace the at-receipt indicator

Today's `onPublished` hook starts typing at inbound publish and blind-caps at 60 s (`telegram-adapter.ts:457–465`, `outbound.ts:37,40`) — typing before any turn is claimed, which `.claude/rules/room-conduct.md` and E16 already name as the shape not to copy. Phase 2 **removes that hook and its 60 s cap** and keys the loop to the turn lifecycle the adapter actually observes: start `sendChatAction('typing')` with the 4 s refresh (`TYPING_REFRESH_MS`, the repo's own measured-safe value under Telegram's ≤5 s expiry) when the downstream turn starts, stop when the terminal arrives (reply sent, or error). Where a Telegram chat is bridged to a **room**, the claim/`done` signals are the lifecycle; on the plain relay-session path, the relay's own delivery→reply span is (the `SignalEmitter` at `packages/relay/src/signal-emitter.ts` is the in-process carrier already wired into `delivery-pipeline.ts:121`). The blind cap is deleted rather than raised: with a real release moment, a safety cap is the ceiling-length `working_late` span, not 60 s of hope. Telegram has no vocabulary beyond `sendChatAction`, so `working_late` renders as continued typing — the platform cannot say more, and that is the platform's limit, not a dishonesty of ours.

> **Correction (task 2.2, at implementation).** The parenthetical above is wrong on two counts, found by reading the code it cites. (1) `delivery-pipeline.ts:121` emits **only** `backpressure` signals; the delivery→reply span is not carried there. (2) The `SignalEmitter` has **zero producers** in production — the only path to it is `RelayCore.signal()`, which nothing in the repo calls, so the `typing` signals the Telegram adapter already subscribes to are never emitted. It could not have been the driver. What the adapter actually observes is the runtime's own event stream, published to `envelope.replyTo` by `claude-code/agent-handler.ts` and arriving at its `deliver()`: the first event of a turn starts the loop, and `done` / `error` / a blocking interaction / a plain finished reply stop it. The signal subscription survives as the **seam** for a room-bridged chat — which does not exist either: room presence goes to the room's own broadcaster and reaches the cockpit, never a relay adapter. Because a terminal is not guaranteed (the `done` publish is best-effort and a stalled stream may never emit one), the loop also self-stops after 60 s of stream silence — restated by every event, so a turn that reports in is never cut.

### 7.2 Slack — status where the surface exists, reaction elsewhere

Slack has no bot typing API. Two honest mappings, chosen by surface:

- **Assistant split-panel threads** (the only surface `assistant.threads.setStatus` works in): set status at claim (`is working on it…`), update once at `working_late` (`still working — taking longer than usual`), clear at terminal. Its 2-minute auto-clear is a platform-side TTL that suits us; the claim-driven refresh keeps it alive while true.
- **Everywhere else**: the shipped reaction machinery (`stream.ts:39,197–207`, FIFO cleanup) re-keyed from receipt to claim: add `:eyes:` on the triggering message at claim, remove at terminal. `:eyes:` replaces the current `:hourglass_flowing_sand:` deliberately — 👀 is the documented Slack-ops and agent-product convention for "seen / on it" (Slack's own blog, GitHub Copilot, Hermes), while an hourglass connotes the platform's own processing. The existing `typingIndicator: 'none' | 'reaction'` config field keeps its shape and semantics (off stays off).

No success/failure emoji is added (no ✅/❌): the terminal is the reply or the relayed error message itself, and Buzz's no-completion-emoji stance held up in their tree.

### 7.3 Buzz connector — their kinds, their pattern

Lands with the community work, and only with a **write-capable** Buzz adapter (the v1 read-only adapter declares `signals: 'none'` and stays that way). Emission maps claim→release onto Buzz's own vocabulary: kind 20002 ephemeral typing events, empty content, republished on their ~3 s cadence, ceasing at terminal (their clients TTL-expire at 8 s — their numbers, from `research/20260729_buzz-presence-signals.md`, not re-derived); optionally the 👀/💬 harness reaction pair with guard-style cleanup on every exit path. Their clients then render our agent exactly as they render their own ("is working", aggregated), which is the point of speaking the native idiom.

## 8. The CommunityAdapter port — presence rides `signals`

The brief sketched a new capability, `presence: ephemeral | reaction | none`, and invited the shape this spec can argue. Argued: **no new flag.** The port's own doctrine decides it twice over:

- **The rule of §Decisions resolved after SPECIFY, OQ6** (`community-adapter:816`; note the document carries a second, unrelated "OQ6" at :63 — tenancy addressing — which is why the qualified name matters): a flag whose value is determined by the rest of the declaration is worse than no flag. Every current and planned backend has `presence` fully determined by `signals`: local `'both'` → ephemeral; community-server `'both'` → ephemeral; read-only Buzz `'none'` → none. A determined flag is a field every fake must vary and every consumer is invited to branch on, that can only ever agree with `signals`.
- **The zero-implementation rule** (`community-adapter:84`): `'reaction'` has no CommunityAdapter implementation to conform against — Slack and Telegram are relay adapters, off this port, and a write-capable Buzz does not exist. Minting the value now is inventing a capability with zero implementations.

What the port genuinely lacks is not a flag but a **payload**: `publishSignal(roomId, signal)` (:468) cannot say who is working, on what, or in which lifecycle phase. So the amendment (Amendment 2 in `specs/community-adapter/02-specification.md`, landing with this spec) extends the method with an optional structured payload mirroring the relay `Signal` envelope's `state`/`data` precedent (`relay-envelope-schemas.ts:145–152`), and strengthens conformance **C15**'s `'both'` branch to round-trip it. Conformance **branches** on `signals` exactly as before and **weakens nothing**: the `'none'` branch still rejects, and the `'both'` branch now proves more. The day a reaction-native backend joins the port, `presence` (or a better-named flag) is minted **then**, alongside the reaction attach point OQ7 reserved — the amendment records that forward shape so it is a known step rather than a rediscovery.

## 9. Etiquette amendment (rides with phase 1)

`meta/agent-etiquette.md` §5 currently reads E15/E16 through the one-agent-one-surface lens and its E16 example set is Telegram-shaped. Phase 1 lands one addition — a new rule, proposed text (final wording at implementation, held to the doc's transcript-checkable bar):

> **E16a. Mechanical presence signals are the system's, not the agent's, and do not count as participation.** A working indicator published by the harness at claim and cleared at release is exempt from every speaking rule above: it is not a turn, not an acknowledgment, and never model-chosen. The exemption is exactly as wide as the mechanism — a signal exists only while the dispatcher holds a real claim for a real trigger, on every surface (cockpit, Telegram, Slack, communities), and anything an agent _chooses_ to send is a message and pays a message's cost.
> _Check: every presence indicator in a transcript window corresponds to a claim held by the dispatcher during that window._

This encodes the sourced record (`research/20260729_platform-presence-patterns.md` §2.5): vendors uniformly exempt mechanical status signals from participation accounting, and the exemption is conditional on the signal being about work someone's trigger caused. E15's "exactly one acknowledgment" is untouched — the presence line does not spend it, so an agent facing a long job still says "on it" once in words when the rhythm calls for it.

**One divergence from the sourced record, chosen rather than smoothed over.** The platform evidence conditions the exemption on being _addressed_ — OpenClaw, the one product that had to pick a default, suppresses signals entirely for unaddressed room events. This spec publishes for **every claimed turn**, including ambient ones (`responseMode: 'always'`, and `engaged` when RP4 lands) where nobody mentioned the agent. Chosen for three reasons. First, the claim is real work spending the operator's budget either way, and an indicator that hides ambient turns understates the system — the operator, not a stranger, is the audience, and honesty-to-the-operator is the product. Second, our rooms today are a single-player cockpit: the "unaddressed signal noise taxes the room" cost OpenClaw priced in assumes an audience of other people, which does not exist here yet. Third, the aggregate line bounds the worst case at one line however many agents fire. The revisit trigger is written down now: **when communities put other people in the room** (RP10, `specs/community-adapter`), the OpenClaw condition applies to what is _emitted outward_, and the P3 adapter work must re-argue rather than inherit this default.

## 10. Provenance of every load-bearing figure

| Figure                                                | Source                                                                                                                                                          | Status                                   |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 10 min wait / 60 min ceiling                          | `config-schema.ts:686,698` defaults; `room-turn-runner.ts:99,102`                                                                                               | re-derived on this branch                |
| 50 min max understatement window                      | ceiling − wait, from the two defaults                                                                                                                           | re-derived (arithmetic)                  |
| 4 s Telegram refresh; ≤5 s expiry                     | `outbound.ts:37`; platform report §1.2 (repo's own prior research)                                                                                              | code re-derived; expiry [not re-derived] |
| 60 s Telegram blind cap                               | `outbound.ts:40`                                                                                                                                                | re-derived                               |
| Slack status 2 min auto-clear; panel-only             | platform report §1.1                                                                                                                                            | [not re-derived]                         |
| Buzz 3 s republish / 8 s TTL / 3× flap rationale      | `research/20260729_buzz-presence-signals.md` §1, §5                                                                                                             | [not re-derived]                         |
| Collapse threshold ~3                                 | platform report §3.2 — community-reported, flagged unverified **there** too                                                                                     | [not re-derived; unverified at source]   |
| `PRESENCE_REPUBLISH_MS` 10 s / `PRESENCE_TTL_MS` 30 s | **ours** — 3× ratio borrowed from Buzz's flap rationale; absolute values unsourced, to be tuned by dogfooding (the `room-participation` §17 discipline applies) | ours, unsourced                          |

The two "ours" values are rendering/liveness constants, not user configuration: nobody should need to tune how fast an indicator clears, and a config field would be a knob with no honest guidance (`room-participation` §13's table exists because those numbers change _behavior_; these change only staleness bounds). If dogfooding demands tuning, that is evidence they were behavior after all, and they graduate to config with the `adding-config-fields` lifecycle.

## 11. Scope table — what lands where

| Item                                                              | This spec                                               | Community programme (`specs/community-adapter` + connectors) | RP-series (`specs/room-participation`) |
| ----------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------- |
| Signal payload, claim fixes, publisher, republish loop            | ✔ (P1)                                                  |                                                              |                                        |
| Cockpit presence line + TTL                                       | ✔ (P1)                                                  |                                                              |                                        |
| Etiquette amendment E16a                                          | ✔ (P1)                                                  |                                                              |                                        |
| `room_presence` global event + sidebar dot + list `working` count | ✔ (P2)                                                  |                                                              |                                        |
| Telegram claim-driven loop, at-receipt hook removed               | ✔ (P2)                                                  |                                                              |                                        |
| Slack status/reaction mapping                                     | ✔ (P3)                                                  |                                                              |                                        |
| `publishSignal` payload amendment + C15 strengthening             | ✔ (P3, the amendment text lands **now** with this spec) | implements it in the local + server adapters                 |                                        |
| Buzz kind-20002/reaction emission                                 |                                                         | ✔ — with the write-capable Buzz connector                    |                                        |
| A future `presence`/reaction capability flag                      |                                                         | ✔ — minted when a reaction-native backend exists (§8)        |                                        |
| Long-post collapse; session link on posted entries                |                                                         |                                                              | ✔ — the remainder of RP9's ticket      |
| `agent_declined` (closes the addressed silent case)               |                                                         |                                                              | ✔ — RP6                                |
| `member_offline` notice (presence-of-the-install)                 |                                                         | ✔ — RP10 rides the community programme                       | ✔ (specified at RP10)                  |
| Telegram `is_bot` loop guard                                      | —                                                       | —                                                            | — DOR-619, independent, unchanged      |

Existing artifacts this touches: `specs/community-adapter/02-specification.md` (Amendment 2, this commit), `meta/agent-etiquette.md` (P1 implementation), `.claude/rules/room-conduct.md` (P1 adds the release-needs-a-durable-sibling invariant to its list), `docs/concepts/rooms.mdx` + regenerated OpenAPI (schema fields), RP9's future ticket (references this spec; keeps collapse + session-link).

## 12. User Experience

1. Dorian posts "can someone check the deploy" in #build. Within a second, under the composer: `Kai is working on it · 2s`, counting up. The sidebar's #build row shows the working dot.
2. Kai answers in 40 s; the line vanishes as the reply lands — never before it.
3. A slow one: at 10 minutes the line changes to `Kai is still working — this is taking longer than usual · 10m` and stays honest until the late reply posts with its "answers the message from N minutes ago" note.
4. A busy one: the line shows, then resolves into the italic notice "Kai is still working on an earlier message here. It didn't pick this one up — that answer will land in this conversation." Indicator and explanation, never indicator and mystery.
5. On Telegram, the same question shows the native "typing…" from the moment Kai's turn actually starts — not from the moment the message was received — and it stops when the answer arrives, however long that takes.
6. Nothing anywhere shows what anyone has read, and no agent can turn its indicator on by wanting to.

## 13. Testing Strategy

House rule first (`room-participation` §15): every check below can fail, and the seeded-defect direction is named.

**Unit / integration (server):**

- Claim taken → one `working` signal with `entryId`, `since`, correct author. Seed: remove the publish call; red.
- Deadline → exactly one `working_late`; claim still present in `workingIn()`; `room_context.working` for a second agent triggered during the late window includes the late author. Seed: revert the lifetime fix (delete claim on `late`); red on both.
- Late settle (fulfilment **and** the `.catch` path) → claim gone, `done` published. The `.catch` path additionally writes one damped `turn_failed` notice (§3.3). Uses the existing `FakeAgentRuntime` held-turn scenarios and a faked clock. Seed: revert the `.catch`'s `reportSilence`; the notice assertion goes red.
- **The damped release** (§4.1 path (a)): two busy refusals for the same `(room, agent)` with no successful turn between them → two full indicator lifecycles (`working` → `done`, twice) and exactly **one** `agent_busy` notice on the log. The second release's durable explanation is the standing notice; assert the log holds one notice and the stream held two `done`s. Seed: clear `noticedSilence` between the refusals; the one-notice assertion goes red.
- **The silent-late-turn refusal** (§3.1): agent A's turn outruns the wait and will end with no text; while A's claim is held `pastDeadline`, a re-trigger of A in the same cascade is refused exactly once (one `cascade_stopped` notice), A's indicator stays live through the refusal, and the existing cascade scenarios gain no new refusals. Seed: drop `claimsIn` from the guard's union; the refusal assertion goes red.
- Every terminal in `01-ideation.md` §3.5's table publishes `done` after its durable write; asserted on stream order (durable event precedes `done`).
- The silent-judgment terminal publishes `done` and writes nothing durable — pinning §4.3's accepted cost as chosen behavior.
- Republish: two live claims, advance fake time 10 s → two re-publishes carrying original `since`; map emptied → timer stops (assert no pending timer).
- Cascade regression guard: the existing cascade suite passes unchanged with claims held longer; a late-turn author re-triggered legitimately is not newly refused.
- Signal framing: `progress` events still carry no `id:` line and are absent from a `Last-Event-ID` replay (extends the existing `collectDurableEvents` SSE tests).

**Client (jsdom + browser):**

- jsdom: store keying `(authorId, entryId)`; `done` clears; TTL expiry clears (fake timers); aggregation copy at 1, 2, 3, 4 agents; two claims for one author render one name with the older `since`; **an entry authored by X clears every `(X, *)` indicator in the room** (the reconnect-after-reply case — seed: feed the store a `working`, then the author's entry with no `done`, assert the line is gone); `stalled` clears the store.
- Browser (per `room-participation` §15: presence rendering is invisible to jsdom): the line appears under the composer during a held fake turn, ticks, and resolves with the reply; the sidebar dot appears and clears. This repo has twice shipped room defects every jsdom test passed and a screenshot caught.
- `sse-event-allowlist.test.ts` proves `room_presence` in both places. Seed: drop the `GENERIC_EVENTS` literal; red.

**Adapters (P2/P3):**

- Telegram: a turn's start (not inbound publish) triggers the first `sendChatAction`; terminal stops the loop; the removed 60 s cap is asserted gone by holding a fake turn 90 s and counting refreshes. Seed: restore the `onPublished` hook; a message that triggers no agent must produce zero `sendChatAction` calls — red today, green after.
- Slack: claim adds `:eyes:`, terminal removes it, FIFO cleanup hits the right message on interleaved turns; `typingIndicator: 'none'` produces zero reaction calls.

**Conformance (P3, with the community work):** C15 `'both'` round-trips the payload on a second subscription; `'none'` still rejects. The runtime-agnostic invariant "no signal without a claim" is asserted at the dispatcher, where it is enforceable, not per-runtime.

## 14. Performance Considerations

Publishing is a map walk plus an in-process broadcast per transition and per 10 s tick per live claim — zero model cost (E7), zero disk, no new timers at idle. SSE payloads are ~150 bytes. The client store is bounded by live claims per open room (≤ roster size). `GET /api/rooms`' `working` count is a claim-map read, no query.

## 15. Security Considerations

- **No new information surface beyond the room's own membership.** The signal rides the per-room stream, which an agent reaches only for rooms it is in, and the person sees for rooms in their sidebar; the payload names an author already in the roster and an entry already in the log. The `working` reason, session content, and cross-room existence are never in the payload.
- **`agent_busy` vagueness preserved** — the signal carries no reason field (§3.4).
- **`sessionId` on the claim is server-internal** and is deliberately _not_ in the signal payload: a click-through-to-session affordance for in-flight turns would hand the client a session id for a turn that may belong to a different surface's lock; posted entries already carry `sessionId` durably, and the in-flight version waits for a design that checks the caller's right to it (noted as RP9-ticket material, not lost).
- **No model influence**: no tool, no context field, no prompt text lets an agent create, extend, or suppress a signal. The one rule of §1 is the security property.
- Community-facing emission (P3) discloses "this member's agent is working in this room" to that room's remote members — the same fact the reply itself discloses seconds or minutes later, and RP10's capability-floor rules govern anything further.

## 16. Documentation

- `docs/concepts/rooms.mdx`: a short "What you see while an agent works" section (presence line, late state, the honesty rule), `writing-for-humans`.
- Regenerated `docs/api/openapi.json` (`pnpm docs:export-api`) for the schema fields and the rooms-list `working` count.
- `.claude/rules/room-conduct.md`: add the release-needs-a-durable-sibling invariant and strike the "no in-flight indicator" implication from its gaps list when P1 lands.
- Changelog fragment per phase (`changelog/unreleased/`), user-facing voice.

## 17. Implementation Phases

| Phase  | Deliverable                                                                                                                                    | Depends on                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **P1** | Claim fields + lifetime fix; signal payload; publisher + republish; cockpit presence line + TTL; E16a etiquette amendment; conduct-rule update | nothing — solves the operator's scenario alone |
| **P2** | `room_presence` global event + sidebar dot + list `working` count; Telegram claim-driven loop (at-receipt hook and 60 s cap removed)           | P1                                             |
| **P3** | Slack status/reaction mapping; CommunityAdapter `publishSignal` payload implemented + C15; Buzz emission                                       | P1; lands with the community work              |
| **P4** | — (folded: the etiquette amendment rides P1 rather than trailing it)                                                                           |                                                |

Each phase is independently shippable, one PR, own worktree, reviewed against `REVIEW.md`. RP9's ticket, when filed at DECOMPOSE, references this spec and retains only long-post collapse + the posted-entry session link.

## 18. Open Questions

All resolved during SPECIFY; originals preserved as the audit trail.

- ~~Should the sidebar dot ride `room_activity`?~~ **(RESOLVED)** No — new `room_presence` event. **Answer:** `room_activity` fires only on committed entries and its payload carries `seq`; a claim has neither (`room-service.ts:864–871`). **Rationale:** overloading it would corrupt its meaning for the existing consumer and dodge the both-ends rule the new name properly triggers (§6).
- ~~Should the room SSE snapshot carry current claims so cold connects render presence instantly?~~ **(RESOLVED)** No — the republish loop covers it within ≤10 s. **Answer:** keep the snapshot durable-only. **Rationale:** the snapshot/replay contract partitions on durability; putting ephemeral state in the snapshot makes every future reader reason about a mixed contract to shave ≤10 s off a line that is absent most of the time. Revisit only if dogfooding shows the gap is felt. **Reversed, 2026-08-24 (ADR 260824-120019, DOR-786).** Dogfooding showed it: the room details sheet opens over rooms whose stream it does not have, where the gap is not ten seconds but permanent. The room BODY now carries `workingAgents` — the entry stream's snapshot/replay contract is untouched, which is what this answer was actually protecting.
- ~~`presence: ephemeral | reaction | none` on the port?~~ **(RESOLVED)** Not now — rides `signals`, payload amendment instead, flag minted when a reaction-native backend exists. **Answer & rationale:** §8; the port's own OQ6/zero-implementation doctrine decides it.
- ~~Should `working_late` also write a durable "will answer late" notice at the deadline?~~ **(RESOLVED)** No. **Answer:** the ephemeral state change is the deadline's announcement; the durable disclosure stays where it ships today, in the late reply's own first line (`withLateAnswerNote`). **Rationale:** a notice at every deadline is a second message about every slow turn (E17's batching instinct says no), and the shipped design already chose silence at the deadline deliberately — this spec makes the silence honest rather than replacing it with chatter. If dogfooding shows people leave the room and miss late answers, that is evidence for a notice, and evidence should buy it.
- ~~Expose in-flight `sessionId` for click-through-to-session?~~ **(RESOLVED)** Not in this spec — stored on the claim, kept server-side (§15); the affordance belongs to RP9's remaining client work with an authorization check.

## 19. Candidate ADRs

Per the SPECIFY skill, decision signals for extraction (not drafted here; DECOMPOSE follows the adversarial review, and `/adr:from-spec` applies the rubric then):

1. **Presence is a mechanical fact of the claim lifecycle, never model-chosen** — the architectural rule of §1/§15, with E16 as its forcing function and the rejected alternative (a model-facing ack/presence tool) recorded.
2. **A claim lives until its turn's terminal, not until the wait deadline** — changes an invariant two subsystems (`room_context`, cascade union) observe.
3. **Ephemeral liveness rides republish + TTL, not stored state** — the crash-honesty design, Buzz's pattern adopted with our numbers.

## 20. Related ADRs

ADR `260726-170125` (room is a membership-scoped durable stream — the signal channel's durability boundary), ADR `260726-170127` (cascade guard — whose in-flight union §3.1 strengthens), ADR-0273 (structured context injection — why no presence text enters prompts), ADR-0310 (runtime-owned sessions — why the claim, not a session store, is the presence source), ADR `260727-184933` (presence follows the install — RP10's `member_offline`, distinct from this spec's working-presence).

## References

- `specs/room-participation/02-specification.md` §11.1 (RP9), §10.2.2 (RP6), §17; `specs/rooms/02-specification.md` :218, :229; `specs/community-adapter/02-specification.md` §2, §3, C15, §Decisions resolved after SPECIFY OQ6–OQ8, Amendments.
- `research/20260729_buzz-presence-signals.md`; `research/20260729_platform-presence-patterns.md` (and the prior repo research they cite).
- `meta/agent-etiquette.md` E7/E11/E15/E16/E17; `.claude/rules/room-conduct.md`.
- Code anchors as cited throughout, read at `c70de1389`.
