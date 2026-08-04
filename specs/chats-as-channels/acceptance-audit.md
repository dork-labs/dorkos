# A13.1 — acceptance audit (chats-as-channels)

> **A13.1:** Every acceptance criterion **A2.1 through A12.2** above has a named test.

This is the walk of the spec's acceptance list against the codebase, done at the DOR-881 closeout. Every criterion resolves to a named test below. The one gap found — **A12.1**, which had no discretely-named pin — was **closed in this PR** (see the last row).

Base paths:

- `BRIDGE/` = `apps/server/src/services/relay/chat-bridge/__tests__/`
- `ROOMS/` = `apps/server/src/services/rooms/__tests__/`
- `RELAY/` = `apps/server/src/services/relay/__tests__/`
- `ROUTES/` = `apps/server/src/routes/__tests__/`
- `SHARED/` = `packages/shared/src/__tests__/`
- `TGIN/` = `packages/relay/src/adapters/telegram/__tests__/inbound.test.ts`
- `CLIENT/` = `apps/client/src/layers/`

| Criterion | Test file                                                | Named test                                                                                                                                                        |
| --------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2.1      | `RELAY/binding-router-bridge.test.ts`                    | `A2.1/A5.2: a bridged binding reaches ingest and NEVER the session creator`                                                                                       |
| A2.2      | `BRIDGE/ingest.test.ts`                                  | `A2.2: a bridged DM turn goes through the real dispatcher (observed as a turn claim)`                                                                             |
| A2.3      | `TGIN`                                                   | `with no respondMode supplied, falls back to the schema default and not to always` (+ `drops a group message that does not address the bot`)                      |
| A3.1      | `BRIDGE/bridged-room-security.test.ts`                   | `ingest for a bridged binding with no live room creates no room, no author, no entry, and runs no turn`                                                           |
| A3.2      | `ROOMS/room-bridged-create.test.ts`                      | `writes a room_bridges row atomically with the room (A3.2)` (+ re-bridge same chat resolves through the bridge store)                                             |
| A3.2b     | `ROOMS/room-bridged-create.test.ts`                      | `creates a second, distinct room when bridging a private chat to an agent the operator already has a private DM with (A3.2b)`                                     |
| A3.2c     | `ROOMS/room-store.test.ts`                               | `never returns a bridged room, even one whose roster matches exactly (A3.2c)`                                                                                     |
| A3.3      | `ROOMS/room-bridged-create.test.ts`                      | `seeds a bridged channel's agent as mention-only, with no observable instant otherwise` (+ failure-of-second-step sibling)                                        |
| A3.4      | `ROOMS/room-bridged-create.test.ts`                      | `appends -2 on a slug collision with a live channel, never throwing (A3.4)`                                                                                       |
| A3.5      | `SHARED/relay-adapter-schemas.test.ts`                   | `rejects bridge: room with no chatId, naming the wildcard reason (A3.5)` (+ route pin in `ROUTES/relay-bindings-integration.test.ts`)                             |
| A3.6      | `ROOMS/room-bridged-lifecycle.test.ts`                   | `archives the room, stamps the bridge row, and deletes neither the row nor its refs` (+ un-archive same id)                                                       |
| A3.6b     | `ROOMS/room-bridged-lifecycle.test.ts`                   | `keeps the room id, swaps the bound agent, drops the old session, keeps the refs, posts ONE notice` (+ mention-only-after-failure)                                |
| A3.7      | `ROOMS/room-bridged-create.test.ts`                      | `refuses a broadcast channel outright (A3.7)`                                                                                                                     |
| A4.1      | `ROOMS/external-authors.test.ts`                         | `resolves two messages from the same person in the same chat to ONE author row (A4.1)`                                                                            |
| A4.2      | `ROOMS/external-authors.test.ts`                         | `resolves the same person under two adapter instances to TWO author rows (A4.2)`                                                                                  |
| A4.3      | `ROOMS/external-authors.test.ts`                         | `updates the display name on a rename WITHOUT minting a second author (A4.3)`                                                                                     |
| A4.4      | `ROOMS/external-authors.test.ts`                         | `marks an external member isPerson AND origin { platform }, from the stored key (A4.4)`                                                                           |
| A4.5      | `ROOMS/external-authors.test.ts`                         | `gives no locally minted author a platform:-prefixed natural key (A4.5)` (+ refuses a local mint that spells the prefix)                                          |
| A4.6      | `ROOMS/external-authors.test.ts`                         | `puts exactly one roster row on the room per member who has SPOKEN (A4.6)`                                                                                        |
| A5.1      | `BRIDGE/ingest.test.ts`                                  | `A5.1: the same platform message id ingested twice → one entry, one turn`                                                                                         |
| A5.2      | `RELAY/binding-router-bridge.test.ts`                    | `A2.1/A5.2: a bridged binding reaches ingest and NEVER the session creator`                                                                                       |
| A5.3      | `BRIDGE/ingest.test.ts`                                  | `A5.3: two concurrent inbound → two entries, seq in acceptance order`                                                                                             |
| A5.4      | `BRIDGE/ingest.test.ts`                                  | `A5.4: a bridged group, agent mention-only, unmentioned message → entry, NO turn, then unread next turn`                                                          |
| A5.5      | `BRIDGE/ingest.test.ts`                                  | `A5.5: @botusername triggers the bound agent; the extra candidate never displaces another member`                                                                 |
| A5.6      | `BRIDGE/ingest.test.ts`                                  | `A5.6: the entry and its external ref are one transaction — a ref failure writes NEITHER`                                                                         |
| A5.7      | `BRIDGE/ingest.test.ts`                                  | `A5.7: a captionless photo → one [photo] entry; a captioned one → placeholder + caption` (adapter half in `TGIN`)                                                 |
| A5.8      | `BRIDGE/ingest.test.ts`                                  | `A5.8: a bridge:room binding with a missing room refuses with an in-chat notice and creates nothing`                                                              |
| A5.9      | `BRIDGE/ingest.test.ts`                                  | `A5.9: past the ingest ceiling → refuses, one damped bridge_rate_limited notice, no entry`                                                                        |
| A5.10     | `BRIDGE/ingest.test.ts`                                  | `A5.10: a forum-topic message carries the topic id and a SANITIZED topic name on its ref`                                                                         |
| A6.1      | `BRIDGE/deliver.test.ts`                                 | `A6.1: an inbound message never round-trips back to the platform`                                                                                                 |
| A6.2      | `BRIDGE/deliver.test.ts`                                 | `A6.2: a retry for an already-delivered entry sends nothing; a crash-simulated ref suppresses the retry`                                                          |
| A6.3      | `BRIDGE/deliver.test.ts`                                 | `A6.3: a cockpit post reaches the chat when canInitiate is on, is blocked (with a notice) when off`                                                               |
| A6.4      | `BRIDGE/deliver.test.ts`                                 | `A6.4: an agent answer reaches the chat with canReply on, is blocked with canReply off`                                                                           |
| A6.5      | `BRIDGE/deliver.test.ts`                                 | `A6.5: a post whose author is neither the bound agent nor the operator is refused inside deliver, before any publish`                                             |
| A6.6      | `BRIDGE/deliver.test.ts`                                 | `A6.6: a turn_failed notice reaches a bridged DM by default and NOT a bridged channel` (+ halted sibling)                                                         |
| A6.7      | `BRIDGE/deliver.test.ts`                                 | `A6.7: a delivered answer to a forum-topic message carries that topic message_thread_id`                                                                          |
| A6.8      | `BRIDGE/presence-bridge.test.ts`                         | `shows a typing action for exactly as long as the turn claim, and clears it on release`                                                                           |
| A6.9      | `BRIDGE/deliver.test.ts`                                 | `A6.9: an operator post carries the display-name prefix on the wire and NOT in the stored body`                                                                   |
| A6.10     | `BRIDGE/bridged-room-security.test.ts`                   | `A6.10: POST /api/relay/messages rejects a client-asserted relay.bridge.* principal 403, publishing nothing` (+ predicates-not-collapsed sibling)                 |
| A7.1      | `BRIDGE/adopt-session.test.ts`                           | `A7.1: after adopting a live started session, the first bridged turn RESUMES that conversation`                                                                   |
| A7.2      | `BRIDGE/adopt-session.test.ts`                           | `A7.2: a sessionMap id that FAILS the transcript probe starts fresh with the pointer-less notice`                                                                 |
| A7.3      | `RELAY/binding-router-bridge.test.ts`                    | `A7.3: a bridged inbound causes no read or write of the session map`                                                                                              |
| A7.4      | `BRIDGE/adopt-session.test.ts`                           | `A7.4: a turn in a bridged room receives room_context containing the prior ROOM entries`                                                                          |
| A7.5      | `RELAY/notify-target.test.ts`                            | `A7.5: resolves the bridged chat with every session vacated from sessionMap`                                                                                      |
| A8.1      | `CLIENT/widgets/room-view/__tests__/RoomHeader.test.tsx` | `A8.1: a bridged group room shows "sees mentions only", sourced from room.bridge.visibility` (+ "sees everything")                                                |
| A8.2      | `CLIENT/widgets/room-view/__tests__/RoomHeader.test.tsx` | `A8.2: a bridged DM room shows no badge — privacy mode is a group concept`                                                                                        |
| A8.3      | `CLIENT/widgets/room-view/__tests__/RoomHeader.test.tsx` | `A8.3: expanding it names Telegram as the switch's owner, the re-add ritual, and the reply-setting gate`                                                          |
| A8.4      | `ROOMS/room-context-bridged-framing.test.ts`             | `reports partial when the platform confirmed privacy mode is ON (A8.4)`                                                                                           |
| A9.1      | `BRIDGE/bridged-room-security.test.ts`                   | `A9.1: a forged fence marker, a system tag, and a newline+marker all render INSIDE the fence with the real nonce intact`                                          |
| A9.2      | `BRIDGE/bridged-room-security.test.ts`                   | `A9.2: a hostile display name, chat title, and forum topic name render in the preamble with no < or > at all, all through the one sanitizeIdentity`               |
| A9.3      | `ROOMS/room-bridged-create.test.ts`                      | `sanitizes a platform-sourced title IN THE STORE, not only at render (A9.3)` (topic-name half: `BRIDGE/ingest.test.ts` A5.10)                                     |
| A9.4      | `ROOMS/external-authors.test.ts`                         | `marks the entry a stranger wrote authorOrigin external, and a local one local (A9.4)` (+ standing-line sibling)                                                  |
| A9.5      | `BRIDGE/bridged-room-security.test.ts`                   | `A9.5: external text the agent quotes back lands in ownRecent (outside the fence) with its tags defused`                                                          |
| A9.6      | `BRIDGE/bridged-room-security.test.ts`                   | `A9.6: every bridge write path leaves permissionMode untouched — enumerated, not sampled`                                                                         |
| A9.7      | `BRIDGE/bridged-room-security.test.ts`                   | describe `§9.3 lever 3 — a stranger cannot speak to a chat the operator never connected (A9.7)` (via A6.5 + A6.10)                                                |
| A10.1     | `BRIDGE/deliver.test.ts`                                 | `A10.1: a delivery failure leaves the entry, rolls the ref back, and writes exactly one bridge_undelivered notice`                                                |
| A10.2     | `BRIDGE/deliver.test.ts`                                 | `A10.2: a 429 holds the chat in seq order — the second delivery cannot publish during the first retry_after wait`                                                 |
| A10.3     | `BRIDGE/deliver.test.ts`                                 | `A10.3: a 403 archives the room, turns the bridge off, and writes a notice with the reason`                                                                       |
| A10.4     | `BRIDGE/deliver.test.ts`                                 | `A10.4: a late answer post is delivered like any other post`                                                                                                      |
| A10.5     | `BRIDGE/ingest.test.ts`                                  | `§10.9: a room archived out of band turns the bridge off and tells the chat once (A10.5)`                                                                         |
| A10.6     | `BRIDGE/bridge-store.test.ts`                            | `rejects a second bridge row for an occupied roomId` (+ occupied `(adapterId, chatId)`)                                                                           |
| A10.7     | `BRIDGE/catch-up.test.ts`                                | `A10.7: an entry committed while the adapter is down is delivered after reconnect, exactly once, by the scan`                                                     |
| A11.1     | `SHARED/room-schemas.test.ts`                            | `accepts bridge_blocked, bridge_undelivered, and bridge_rate_limited` (+ still-accepts-every-pre-existing-code)                                                   |
| A11.2     | `SHARED/relay-adapter-schemas.test.ts`                   | `parses a fixture written before this field existed, defaulting to off and routing as before (A11.2)`                                                             |
| A11.3     | `RELAY/initiate-consent.test.ts`                         | `isConsentExemptPrincipal still answers false for relay.bridge.* — the two predicates cannot be collapsed`                                                        |
| A12.1     | `RELAY/binding-router-bridge.test.ts`                    | **`A12.1: an UNbridged binding on the same router still dispatches to a session, byte-identically to before the bridge existed`** — added in this PR (gap closed) |
| A12.2     | `ROUTES/relay-bindings-bridge.test.ts`                   | `A12.2: one PATCH { bridge: "room" } on a DM fires BridgeLifecycle.bridge once and flips the binding — no restart`                                                |

## Gap found and closed

**A12.1** — _"With no bridge enabled anywhere, the full existing relay test suite passes unchanged."_ This is a suite-level meta-criterion, and before this PR no single named test pinned it; it was satisfied only implicitly by the whole pre-existing relay/`binding-router` suite staying green. This PR gives it a discrete pin: `binding-router-bridge.test.ts` now carries **`A12.1: an UNbridged binding on the same router still dispatches to a session, byte-identically to before the bridge existed`** — on the same router that can route a bridge, a `bridge: 'off'` binding never touches `ingest`, creates a session, and republishes to `relay.agent.*` exactly as before. It is what a future edit that leaks bridge behaviour into the unbridged path would trip.

All other criteria (A2.1–A11.3, A12.2) already had at least one named test, most embedding the literal criterion id.
