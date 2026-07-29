---
slug: room-presence
id: 260729-145341
created: 2026-07-29
status: ideation
---

# Room presence — what a room shows between a question and its answer

**Slug:** room-presence
**Id:** 260729-145341
**Author:** Tansy (directed by Dorian), IDEATE stage
**Date:** 2026-07-29

---

## 1) Intent & Assumptions

- **Task brief:** A person posts in a room and gets dead air until the agent's reply lands — no "heard you", no "working on it", nothing when the turn runs long. Give rooms an honest presence signal: a mechanical working indicator derived from the turn lifecycle, published at claim and release, rendered as a presence line in the cockpit and mapped to each chat platform's native idiom. The design was approved by the operator before this stage; this document records the evidence it stands on and the decisions as resolved.
- **Assumptions:**
  - `specs/room-participation/02-specification.md` §11.1 (RP9) is the designated home for status signals; this spec realises RP9 and extends it, it does not compete with it.
  - The ephemeral signal channel (`RoomSignalEventSchema`, the no-`id:` SSE framing, `publishSignal`) is the transport. No new channel is invented.
  - Presence is **mechanical**: derived from the dispatcher's claim lifecycle, never chosen by the model. An agent cannot claim to be working.
  - The community programme (`specs/community-adapter`, `specs/community-server`) is where remote-member presence lands; this spec supplies the port-level shape it needs and nothing more.
- **Out of scope:**
  - Read receipts and seen-by lists, in any form (decision 7, §6).
  - Model-chosen acknowledgments (a model calling a "react" or "ack" tool).
  - Queue state ("2 messages waiting for Kai") — no queue exists (`room-trigger.ts` dispatches everything immediately) and the `agent_busy` notice's deliberate vagueness is kept.
  - Reactions as a room feature. The entry-id attach point stays reserved (`specs/rooms/02-specification.md:108`).
  - Streaming partial reply text into the room. A room reply arrives as one committed entry; that boundary is untouched.
  - Human typing indicators. Nothing in the cockpit emits or renders "Dorian is typing"; this spec is about agents working.

## 2) Pre-reading Log

- `specs/room-participation/02-specification.md` — RP9 (§11.1, lines 674–688) already specifies both ends of the wire: dispatcher publishes `progress` on claim and release; client renders "a lightweight presence line under the composer, never as a message" (:682–683). E16 restated at :684. RP9 has no dependencies and is parallel-runnable (:723, :726). `room_context.working` is "presence, not arbitration" (:313); §17 admits there is no evidence the working list changes agent behavior (:809).
- `specs/rooms/02-specification.md` — the settled boundary: "Ephemeral signals never enter the room log … reuse `SignalTypeSchema` … rather than declaring new names" (:229). The both-ends rule for global event names: server broadcast + client `GENERIC_EVENTS` or the event is silently dropped; R1 shipped that bug (:218). Reaction attach point at :108.
- `specs/community-adapter/02-specification.md` — line numbers below are from the tree **after** this branch's Amendment 2 markers landed (they shifted everything later in that file): `signals: z.enum(['none','both'])` (:267); `publishSignal(roomId, signal): Promise<void>`, "Live only; never durable" (:468); conformance C15 (:760 — its number comes from §Decisions resolved after SPECIFY, OQ6's `resume` cut, which deleted the original C15 and renumbered C16–C19 down, not from Amendment 1); §Decisions resolved after SPECIFY, OQ8 cut `'receive'` (:818) on the "capabilities describe the adapter, not the protocol" doctrine; §Decisions resolved after SPECIFY, OQ6 (:816) cut a flag whose value was determined — the precedent this spec's capability decision follows (the bare name "OQ6" is ambiguous in that document: an unrelated tenancy OQ6 sits at :63, which is why every reference here is qualified). Amendment idiom: inline `**[Amended …]**` marker at the original claim, full amendment section appended, original text intact.
- `meta/agent-etiquette.md` — E7 silence must be free (:101), E15 acknowledge once before a long silence (:138), E16 never fake typing, never pad latency (:142), and the simulated-delay dispute resolved against simulation for our users (:235–236).
- `.claude/rules/room-conduct.md` — a refusal is visible (:50–59); the two deliberate silences already pinned by tests; bounds are mechanisms, never prompts.
- `research/20260729_buzz-presence-signals.md` — Buzz's full presence stack, read at their `55a3ed7b`. Load-bearing findings in §4 below.
- `research/20260729_platform-presence-patterns.md` — Slack/Telegram/Discord/Matrix/iMessage mechanics, the etiquette literature, and the three DorkOS tensions. Load-bearing findings in §4 below.
- Codebase survey (uncommitted scratchpad artifact, 2026-07-29, read against `main`) — folded into §3 with every claim re-verified against this branch (`origin/main` @ `c70de1389`). Drift found in re-verification is noted inline.

## 3) Codebase Map

Every `file:line` below was re-read on this branch (`c70de1389`), not inherited from the survey. Where the survey's line numbers had drifted, the current number is given.

### 3.1 The claim store is the presence fact, already computed

The trigger dispatcher claims each target **before** its turn runs: `claimed: Map<string, ActiveClaim>` keyed `(roomId, cascadeRoot, authorId)` (`apps/server/src/services/rooms/room-trigger.ts:220`, `claimKey` at :810), written in `claimTargets` after addressing, cascade guard, and budget all pass and after the session is bound (:451–463). `ActiveClaim` carries `{ roomId, cascadeRoot, authorId, depth, claimedAt }` (:780–787) — **no triggering entry id and no sessionId**, though `target.sessionId` is resolved six lines above the `claimed.set` (:451–457). The claim is deleted in `runOne`'s `finally` when `runner.run()` resolves (:554).

`workingIn(roomId)` already enumerates `[{authorId, since}]` off that map (:758–766). It is `private`, and its only consumer is `buildRoomContext` (:520–527 threads it into `room_context.working`; `apps/server/src/services/rooms/room-context.ts:112`, self filtered out at :210–212). The exact data a human presence line needs is computed on every trigger and handed to the model, then thrown away.

### 3.2 The wait deadline drops the claim while the turn still runs

`room-turn-runner.ts`: the wait defaults to 10 minutes (`DEFAULT_REPLY_WAIT_MS`, :99; config `rooms.replyWaitMinutes`, `packages/shared/src/config-schema.ts:686`) and bounds the **wait, never the turn**. The hard stop is the 60-minute ceiling (`DEFAULT_LATE_REPLY_CEILING_MS`, :102; config :698). When the deadline passes, `run()` returns `{ text: null, late: collecting.afterDeadline }` (:224) — so `runOne`'s `finally` deletes the claim at the deadline, and `deliverLate` (`room-trigger.ts:615`) carries the still-running turn in a closure. Its own doc comment says so: "The claim on `(room, cascade, author)` is already gone by then" (:609–611). Consequence: a slow turn vanishes from `workingIn` — and from `room_context.working` — up to **50 minutes** (ceiling minus wait, from the two config defaults) before its late answer posts. The dispatcher's scalar `inFlight` counter does still count it (:622), so `idle()` holds; only the per-agent claim is lost.

### 3.3 The signal channel exists end to end and is inert

- `RoomSignalEventSchema` (`packages/shared/src/room-schemas.ts:534–541`; survey said 536–548, drifted): `{ type:'signal', signal: SignalType, authorId, at }` — **no state, no payload, no entry reference**. The relay's own `Signal` envelope does carry `state` and `data` (`packages/shared/src/relay-envelope-schemas.ts:145–152`).
- `SignalTypeSchema` (`relay-envelope-schemas.ts:20–22`): `typing | presence | read_receipt | delivery_receipt | progress | backpressure`. The rooms spec requires reuse, never new names (:229). RP9 designates `progress` for claim/release (:682).
- `RoomService.publishSignal(roomId, signal, authorId)` (`apps/server/src/services/rooms/room-service.ts:716–723`; survey said 718–725, drifted). **Zero production call sites** — re-verified by grep over `apps/server/src`, `apps/client/src`, `packages` on this branch: the definition, plus one test that exercises the channel end to end (`apps/server/src/routes/__tests__/rooms-events.test.ts:291`) and moves with any signature change.
- SSE framing: only entries get an `id:` line (`apps/server/src/routes/room-events-handler.ts:118`), replay reads only `entriesAfter` (:139), the live dedupe watermark applies only to entries (:154) — signals are dropped on replay by construction. The stream heartbeats (`: keepalive`, :95).
- Client: `use-room-stream.ts:154–157` reads signals off the wire and drops them, with a comment saying no view consumes them.

### 3.4 What the room shows while nothing is happening: nothing

The room widgets (`apps/client/src/layers/widgets/room-view/ui/`) render entries and exactly one non-entry affordance: the stalled-stream banner (`ChannelsPage.tsx:123`). No typing indicator, no in-flight indicator, no presence line. Posting is not optimistic (`use-post-to-room.ts:10` — the entry arrives back on SSE). Between send and reply, the poster sees their own message echo and then dead air.

### 3.5 Every terminal path today, and what it leaves behind

Re-derived from `deliver` (`room-trigger.ts:566–600`) and the runner:

| Terminal                                    | Durable artifact                                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Turn closes with text                       | A `post` entry, carrying `sessionId`                                                                                                                                           |
| Session locked by another writer            | One `agent_busy` notice, damped per `(room, agent)` (`reportSilence`, :656+)                                                                                                   |
| Turn errors, or hits the ceiling            | One `turn_failed` notice (late failures included: `afterDeadline` resolves `unanswered: 'failed'` at `room-turn-runner.ts:363–366` and `deliverLate` routes through `deliver`) |
| Turn outruns the wait, then closes          | A `post` entry with the late note (`withLateAnswerNote`, `room-notices.ts:125–130`)                                                                                            |
| Turn closes with **no text and no failure** | **Nothing.** `deliver` returns without posting: "An agent with nothing to say is exercising judgment, not failing" (:585–588)                                                  |

Three caveats the table's rows compress, each a real release-without-fresh-durable path the spec's §4.1 accounts for: the busy/failed notices are **damped per `(room, agent)`** — `reportSilence` early-returns while the silence key is armed (`room-trigger.ts:663`), so a repeat before the agent's next successful answer writes nothing new and the standing notice is the record (this bounds the late-failure row too: durable once per `(room, agent)` until recovery, not once per failure); `writeNotice` itself can return `false` on the archived-room race its comment names (:716–727); and `deliverLate`'s `.catch` (:634–640) — the late delivery itself throwing — leaves only a log line today (the spec's §3.3 closes that one). The last row is the one deliberate indicator-then-nothing a presence signal will surface; `.claude/rules/room-conduct.md:54–59` pins it as one of the two deliberate silences. Notice codes are still exactly four (`room-schemas.ts:68–70`): `cascade_stopped`, `budget_reached`, `agent_busy`, `turn_failed`. RP1's `agent_silent_here` and RP6's `agent_declined` are not shipped.

### 3.6 The busy path is refuse-with-notice, deliberately vague

All room turns share one lock identity (`ROOM_CLIENT_ID = 'dorkos-room'`, `room-turn-runner.ts:60`); same-client re-acquire is permitted, so the reachable busy case is a foreign clientId on the room-bound session — in practice the operator typing into that session in the cockpit. The refusal returns `{ text: null, unanswered: 'busy' }` (:212) and the notice copy is maximally vague by construction: "was busy with something else and did not pick this up" (`room-notices.ts:80`) — **no cross-room leakage**. No queue exists anywhere on the dispatch path.

### 3.7 The adapters' current indicators

- **Telegram**: real typing, wrong trigger. `startTypingWithTimeout` sends `sendChatAction('typing')` immediately, refreshes every 4 s (`TYPING_REFRESH_MS`, `packages/relay/src/adapters/telegram/outbound.ts:37`), and blind-caps at 60 s (`MAX_TYPING_DURATION_MS`, :40). It is started by the `onPublished` hook **at inbound publish** — before any turn is claimed or even dispatched (`telegram-adapter.ts:457–465`). It can show typing for an agent that never runs, which is the shape E16 forbids. A second, uncapped refresh loop exists in `grammy-platform-client.ts:163–183` (`startTyping`/`stopTyping` platform methods).
- **Slack**: no bot typing API; the adapter ships `typingIndicator: 'none' | 'reaction'` (`slack/outbound.ts:66`, `stream.ts:85`) — an `:hourglass_flowing_sand:` reaction added to the inbound message (`stream.ts:197–207`) and removed on done/error, with a FIFO of pending reactions (:39–43).
- **Relay core**: a first-class in-memory `SignalEmitter` (`packages/relay/src/signal-emitter.ts`) — typed, pattern-subscribed, never durable, over the same `SignalType` vocabulary; `delivery-pipeline.ts:121` already emits through it. The ephemeral/durable split exists at every layer; what is missing is a producer on the rooms path and consumers.

### 3.8 The global stream and the sidebar

`publishEntry` broadcasts `room_activity` `{roomId, seq, lastActivityAt}` on every committed entry (`room-service.ts:864–871`); the client allowlists it (`stream-manager.ts:181`) and `use-room-list-stream.ts:23` consumes it for unread/reorder. **`room_activity` fires only on committed entries and carries no working semantics** — a claim-time sidebar dot cannot ride it as-is; it needs a sibling event name, which triggers the both-ends rule (`specs/rooms/02-specification.md:218`, guard `sse-event-allowlist.test.ts`).

### 3.9 What has shipped since the survey

Re-verification found the tree moved without invalidating any load-bearing claim: the thread-as-entry-relation change is merged (replies carry `threadRootEntryId` through `deliver`), `room_context` (RP2) is live, and line numbers drifted by a few lines in `room-schemas.ts`, `room-service.ts`, and `specs/rooms/02-specification.md` (reaction attach point is now :108, not :102). RP3 (`joinedSeq` — no hits in `packages/db/src/schema/rooms.ts`) and RP4 (`ResponseModeSchema` still four values, `mesh-schemas.ts:73`) are unshipped.

## 4) Research

Both reports are committed; only the load-bearing findings are restated here.

**From `research/20260729_buzz-presence-signals.md`:**

- Buzz renders one wire event two ways: humans get "is typing…", **agents get "is working"** — agent typing is routed away from the human typing row entirely and folded into a collapsed activity bar ("N agents working") (§1, §7). This is the strongest prior for our "agents do not type — they work" rule.
- Their agent indicator is **harness-driven, never model-chosen**: typing starts when a batch is dispatched (turn start), republishes every 3 s, and stops on the turn's result — success or failure — with panic-recovery cleanup; a crashed harness stops republishing and the client TTL (8 s) clears it (§1). No stop event exists; expiry is the honesty mechanism.
- The 👀/💬 reaction lifecycle is likewise harness-automatic, with a structural `ReactionGuard` that removes both emoji on any exit path (§2).
- **The read cursor is explicitly not a read receipt**: per-device, encrypted to the user's own key, with spec text — "clients that expose read activity to other users MUST require explicit user consent." Agents have no cursor at all (§3).
- Failure honesty is their weak point: an agent that ran and chose silence leaves no durable trace, and a gate-rejected message is indistinguishable from one never delivered (§6). Our notice system already does better; presence must not regress it.

**From `research/20260729_platform-presence-patterns.md`:**

- The convergent shape across AI products doing 30 s+ work: **fast ack, then a labeled working state carrying information (what/how long), never a bare typing indicator stretched past its social meaning** (§3.1). A typing indicator means "message imminent" on every human platform.
- Aggregation is the entire industry answer to N simultaneous signallers — collapse at render past ~3 (community-reported threshold, unverified), Matrix aggregates at the protocol level; no platform rate-limits or arbitrates indicators (§3.2).
- Indicator-then-nothing is the documented failure ("three-dot anxiety"); short TTLs are the human platforms' honesty mechanism; Linear is the one system that made the hang itself a visible state (unresponsive/stale) (§2.2, §3.3).
- Read receipts create sender expectation and receiver obligation; every platform's privacy trajectory moved toward opt-out or private-by-choice; presence metadata is a documented abuse vector (§1.5).
- Vendor guidance uniformly treats mechanical status signals as **distinct from conversational participation** — Slack requires an immediate status signal in the same document that demands minimal channel responses; Linear marks a silent agent "unresponsive" within 10 s. The exemption is conditional: OpenClaw suppresses signals for unaddressed room events (§2.5). This is the evidence base for the etiquette amendment.
- Telegram `sendChatAction` shows ≤5 s and needs a refresh loop (our 4 s value is the repo's own prior); Slack `assistant.threads.setStatus` works only in the AI-assistant split-panel surface and auto-clears after 2 minutes; Slack has no bot typing API at all (§1.1–1.2).

## 5) Decisions

Approved by the operator before this stage; recorded with rationale so a later PR cannot quietly reverse them. No open clarifications remain — the brief was a detailed design, so per the IDEATE skill's maturity ladder this fast-tracks to SPECIFY.

| #   | Decision                                                                                                                                                                                                                                                                                                                      | Choice / Rationale                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Presence is a **mechanical fact derived from the turn lifecycle** — published at claim and release, never model-chosen.                                                                                                                                                                                                       | The claim map is real work, already computed (§3.1). E16 forbids anything else. Buzz's harness-driven lifecycle is the working precedent (§4). A model-facing "I'm working" tool would let an agent fake presence and would cost a turn to be honest.                                                                       |
| 2   | **One signal, per-agent grain**, keyed (room, agent, triggering entry), on the existing ephemeral channel. Client renders a presence line under the composer; single agent with elapsed time; aggregate past ~3. **Agents work, they do not type** — own affordance and copy, never a human is-typing row.                    | RP9 specified the line and the channel (:682–683). Per-agent grain matches the claim map's grain; aggregation-at-render is the industry answer to N agents (§4). Buzz's routing of agent signals away from the human typing affordance is the pattern.                                                                      |
| 3   | **Claim fixes**: store the triggering entry id + sessionId on the claim; **keep the claim alive past the wait deadline until the turn resolves**, and at the deadline the signal moves to a "taking longer than usual" state instead of dropping.                                                                             | Both fields are known at claim time and are one-field additions (§3.1). The 50-minute understatement window (§3.2) is a real dishonesty: the indicator would vanish while work continues, which is the indicator-then-nothing failure the literature names. This also fixes `room_context.working` understating for agents. |
| 4   | **Failure honesty preserved**: every terminal path still ends in a durable entry or notice; the signal's release rides the same moments. The one accepted indicator-then-nothing: an agent that ran and deliberately said nothing.                                                                                            | §3.5's table is the inventory: four of five terminals already leave a durable artifact. The fifth is legitimate conduct (deliver's own comment; room-conduct pins it) and the accepted cost is stated in the spec rather than papered over. RP6's `agent_declined` closes the addressed half of it later.                   |
| 5   | **No read receipts. No model-chosen acks. No queue state.**                                                                                                                                                                                                                                                                   | Privacy trajectory and obligation literature (§4); Buzz's own encrypted-cursor stance; agents have no read cursor to receipt from (nothing advances one). No queue exists to show (§3.6), and `agent_busy`'s vagueness is a leak-free property worth keeping.                                                               |
| 6   | **Adapters map to native idiom**: Telegram — claim-driven `sendChatAction` loop (4 s refresh) replacing the at-receipt blind 60 s indicator; Slack — assistant status where its surface exists, reaction-ack at claim removed at terminal elsewhere; Buzz connector — their ephemeral typing kind + harness reaction pattern. | Each platform's honest vocabulary differs; forcing one shape through all three would fake it on two. The current Telegram trigger point is the E16 violation shape (§3.7) and is replaced, not wrapped.                                                                                                                     |
| 7   | **CommunityAdapter**: presence rides the existing `signals` capability; `publishSignal` gains a structured presence payload. **No new capability flag is minted now**, and reaction-idiom presence is recorded as the future value that arrives with a backend that has it.                                                   | The brief sketched `presence: ephemeral \| reaction \| none`; SPECIFY resolves it the way the port's own doctrine demands (OQ6: a flag whose value is determined by another flag says nothing; §84: no capability with zero implementations). Argued in full in the spec §8 and the amendment.                              |
| 8   | **Etiquette amendment** rides with phase 1: presence signals are mechanical and exempt from over-participation accounting; indicate only while actually working; generalised beyond Telegram.                                                                                                                                 | The vendor-guidance evidence (§4) supports the exemption; the CHI 2023 obligation finding bounds it. `meta/agent-etiquette.md` is the North Star and must not lag the mechanism it governs.                                                                                                                                 |
| 9   | **Phasing**: (1) server publishes claim/release/deadline + cockpit presence line; (2) Telegram + sidebar working-dot; (3) Slack mapping + port payload + Buzz emission, with the community work; (4) etiquette amendment rides with 1.                                                                                        | Phase 1 alone solves the operator's scenario. Ordering is by harm removed per unit work, matching the room-participation programme's convention.                                                                                                                                                                            |

## 6) Recommended direction

Proceed directly to SPECIFY (`02-specification.md`, same commit): the design is decided, the evidence is verified, and the open sketches the brief left (capability shape, sidebar event mechanism) are resolved there with rationale. DECOMPOSE waits for the adversarial review.
