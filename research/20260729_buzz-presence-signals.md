# Buzz — presence, typing, read cursors, and acknowledgement signals

**Subject:** `github.com/block/buzz` (Block's agent-in-chat workspace, Apache-2.0).
**Commit read:** `55a3ed7b9217cee5b23e0a5441947dc929b2a38c` ("fix(desktop): clear stale thread new-message pill (#3411)", branch `main`). Full working tree (sparse checkout disabled; 26 crates + `desktop/`). Every `file:line` below is from that tree. Shallow clone — no history, so no design-intent from commit messages.
**Prior context assumed** (not re-derived here): the 21-reply agent storm and prompt-only loop prevention (`research/20260727_buzz-conversational-behavior.md` §3), the encrypted-read-cursor overview and nip05 handles (`research/20260728_handle-systems-prior-art.md`, `research/20260727_buzz-protocol-capability-spike.md` §7).

Kind constants used throughout (`crates/buzz-core/src/kind.rs`): `KIND_REACTION = 7` (:58), `KIND_READ_STATE = 30078` (:75), `KIND_PRESENCE_UPDATE = 20001` (:403), `KIND_TYPING_INDICATOR = 20002` (:407), `KIND_HUDDLE_REACTION = 24810` (:412), `KIND_PRESENCE_SNAPSHOT = 40902` (:443), `KIND_AGENT_TURN_METRIC = 44200` (:485).

---

## 1. Typing indicators

**Yes — and Buzz renders the same wire event two different ways depending on who sent it: humans get "X is typing...", agents get "X is working".**

### Transport

One mechanism for humans and agents: a signed, ephemeral Nostr event, kind `20002`, **empty content**, tagged `["h", <channel-uuid>]` plus optional `["e", root, "", "root"]` / `["e", parent, "", "reply"]` thread tags so the indicator is scoped to a specific thread (`crates/buzz-acp/src/relay.rs:842-871`, `build_typing_event`). Ephemeral kinds (20000–29999) are never stored; they ride the WS fan-out only.

There is **no stop event**. Stopping typing = ceasing to republish; the client expires entries on a timer (below).

### Agent (harness) lifecycle

- **Start:** when a batch is _dispatched_ to an agent subprocess (turn start), the channel is inserted into a `typing_channels` map together with the triggering event's thread tags (`crates/buzz-acp/src/lib.rs:2553-2555`, also the requeue-flush paths at :1777-1779, :2389, :2412; scope computed from the batch's last event at :2922-2926). Queued-but-not-yet-dispatched events do **not** produce typing — they only get the 👀 reaction (§2).
- **Republish cadence:** a 3-second interval timer (`lib.rs:1592-1600`) re-signs and re-publishes a kind-20002 event for every channel in `typing_channels` (`lib.rs:2322-2342`). Publish is fire-and-forget via `try_send` so a congested command channel drops the indicator instead of blocking the main loop (`relay.rs:830-841`; the drop is debug-logged at `lib.rs:2338`).
- **Slow turn:** nothing special — the 3s republish continues for the whole turn (default `max_turn_duration` is 7200s), so the indicator stays lit for hours if the turn runs for hours.
- **Stop:** the channel is removed from `typing_channels` when the turn's result arrives — success _or_ failure (`lib.rs:2353-2356`), when the agent loses the channel (`lib.rs:1996-1999`), and in panic recovery (`lib.rs:3460-3463`, `recover_panicked_agent`). If the harness process itself dies, republishing simply stops and the client-side TTL clears the indicator within 8 seconds.
- **Config:** `--no-typing` / `BUZZ_ACP_NO_TYPING` disables it entirely (`crates/buzz-acp/src/config.rs:382`, `:1063`).

### Human (desktop) lifecycle

The composer throttles sends to at most one kind-20002 per 3 seconds per channel (`desktop/src/features/messages/useTypingBroadcast.ts:5`, `:25-49`).

### Client-side expiry and hygiene (`desktop/src/features/messages/useChannelTyping.ts`)

- TTL 8s per entry, pruned on a 1s interval (`:29-30`, `:224-231`).
- An indicator whose `created_at`-based expiry has already passed on arrival is ignored (`:87-90`); live entries expire at `min(now + 8s, created_at*1000 + 8s)` (`:124`).
- Entries are keyed `(pubkey, threadHeadId)` (`:64-66`) so channel-level and per-thread indicators are independent.
- When the typer's actual message lands (kind 9 / message-diff, `:49-58`), their indicator is cleared immediately and re-suppressed for 2s (`:31`, `:160-176`) — no "typing" flicker right after a send.
- Forum-type channels don't subscribe to typing at all (`:180-182`).

### Failure mid-indicator

A failed turn stops the indicator exactly like a successful one (result-path removal, `lib.rs:2353-2356`) — the user sees typing vanish with no message. Only after retries are exhausted does an explanation appear (§6).

---

## 2. The "heard you" signal — reactions as a two-phase status light

**Yes: a harness-automatic (never model-chosen) two-emoji lifecycle on the triggering message itself.**

```
//   👀  "seen"    — event was queued and an agent will handle it
//   💬  "working" — agent is actively prompting
```

(`crates/buzz-acp/src/pool.rs:3159-3169`; constants `REACTION_SEEN`/`REACTION_WORKING` at `pool.rs:3510-3511`.)

- **👀 at queue-push:** added fire-and-forget the moment the triggering event is accepted into the per-channel queue — i.e. after all deterministic gates pass but possibly long before a turn runs (`crates/buzz-acp/src/lib.rs:2204-2216`). Only if `queue.push` accepted the event (not dropped by `DedupMode::Drop`).
- **💬 at turn start:** spawned just before the prompt fires, capped at 10 concurrent REST calls for large batches (`pool.rs:1877-1886`, `react_working` at `pool.rs:3696-3706`).
- **Mechanism:** each is a _real, channel-visible_ signed Nostr kind-7 reaction (NIP-25) submitted via REST `POST /events` (`pool.rs:3534-3541`); removal is a signed kind-5 deletion of the reaction event (`pool.rs:3672-3691`). So every channel member sees the agent's 👀/💬 exactly like a human reaction.
- **Cleanup is structural:** `ReactionGuard`, created at the top of `run_prompt_task` (`pool.rs:1418-1422`, struct at `pool.rs:3188`), removes **both** emoji on _any_ exit path — normal return, early return, or panic (`pool.rs:3171-3199`, removal calls `pool.rs:3714-3721`). Per-call budget 500ms add / 1000ms remove; failures are debug-logged and ignored — "reactions are cosmetic."
- **No success/failure emoji exists.** Grep for ✅/❌/🚫/⏳ across `crates/buzz-acp/src`: zero hits. Completion is signalled only by the _disappearance_ of 💬 (plus the reply, if any).
- Known cosmetic races are documented in-source: a fast-failing turn can strand a stale 👀 (`pool.rs:3183-3187`); membership revocation can strand 👀 on drained events because the DELETE 403s after the relay revokes access (`lib.rs:2000-2016`).
- **Retries:** the guard strips both emoji when an attempt fails; on re-dispatch 💬 is re-added (`run_prompt_task` runs again) but 👀 is **not** — its only add-site is relay-event queue-push (`lib.rs:2212` and `pool.rs:3704` are the sole `reaction_add` call sites).

Entirely harness-driven; the model neither chooses nor sees these. (Model-chosen reactions: §4.)

---

## 3. Read receipts / read cursors

**Confirmed: the read cursor is real, per-device, end-to-end encrypted to the user's own key — and it is by explicit spec text _not_ a read receipt. Nobody, human or agent, can see what anyone else has read. Agents don't have a cursor at all.**

### What the cursor is

Buzz's own draft NIP-RS ("Cross-Device Read State Sync", `docs/nips/NIP-RS.md`) riding NIP-78 kind `30078`:

- Addressable event with `["d", "read-state:<slot-id>"]` (slot = random 32-hex per client _installation_, not per member) and exactly one `["t", "read-state"]` tag (NIP-RS.md, Event Structure).
- `content` is a **NIP-44 ciphertext whose conversation key is `nip44_conversation_key(user_privkey, user_pubkey)`** — the user encrypting to themself (NIP-RS.md, Content; ECDH-with-self spelled out at NIP-RS.md:503).
- Plaintext: `{ v: 1, client_id, contexts: { <context-id>: <unix-ts> } }` — "read up to time T" per context. Context keys are opaque, with well-known `thread:<root-id>` and `msg:<event-id>` schemes; merge is monotonic (no mark-as-unread).
- Desktop implementation: `desktop/src/features/channels/readState/readStateFormat.ts:1-38` (blob shape, 7-day horizon, 32 KB plaintext budget, up to 8 slots) and `readStateManager.ts:680` (`nip44EncryptToSelf(plaintext)` immediately before signing/publishing).
- The relay validates the _envelope only_ — kind, single `d` tag with `read-state:` + 32-lowercase-hex slot, exactly one `read-state` `t` tag (`crates/buzz-db/src/lib.rs:3728-3745`); a valid envelope gets `is_nip_rs`, which makes superseded versions hard-delete instead of tombstone (`:3752`, `:3876`). Stored as a global, user-owned, channel-less event (`crates/buzz-relay/src/handlers/ingest.rs:392-400`).

### Why encrypted — the stated rationale

The spec is self-documenting on intent:

- Abstract: "This NIP is **not a read-receipt protocol**. It does not expose what another user has read, and it does not tell other users what messages the current user has read" (NIP-RS.md:15-17).
- Non-Goals: "This NIP does not define read receipts, seen-by lists, or any mechanism for tracking what other users have read" (:31-33).
- Privacy Considerations (:534-556): context IDs, timestamps and `client_id` "are not visible to relay operators or other users"; residual metadata leaks are enumerated honestly (slot count reveals device count, ciphertext length correlates with activity); and: "**This NIP does not authorize read receipts; clients that expose read activity to other users MUST require explicit user consent.**"

### Are there read receipts at all?

No. Grep for `seen.by`/`seen_by`/`read receipt`/`readReceipt` across `desktop/src`, `crates`, and `docs` (excluding NIP-RS itself): zero product hits. The cursor drives only the local user's own unread affordances (unread dividers/badges — e.g. `desktop/src/features/communities/useCommunityUnread.ts`, `useHomeInboxReadState.ts`).

### Does an agent have one?

No. Zero references to `read-state`/`read_state`/`KIND_READ_STATE` anywhere in `crates/buzz-acp/src` or `crates/buzz-cli/src` (grep). The harness subscribes with `since=now` and never backfills; the agent's "position" is whatever it fetches on demand (`buzz feed get`, `buzz messages get`). The nearest agent-side analogue of "received" is the harness's 👀 reaction (§2) — a per-message, channel-visible ack, philosophically the opposite of the human cursor (private, aggregate).

---

## 4. Reactions generally

**Standard NIP-25.** Reaction = kind 7 with the emoji (or `:shortcode:` for custom emoji) as content; removal = kind 5 deletion. Three classes of author:

1. **Humans** — full desktop UI: hover reactions, emoji picker with custom-emoji support (resolution of `:shortcode:` to an image URL via an `["emoji", shortcode, url]` tag, `desktop/src/features/messages/hooks.ts:654-660`; picker at `desktop/src/features/messages/ui/ComposerEmojiPicker.tsx`).
2. **The harness (system)** — the automatic 👀/💬 lifecycle of §2, signed with the _agent's_ key, so in the UI they read as the agent reacting.
3. **The model, by choice** — the CLI exposes `buzz reactions add / remove / get` (`crates/buzz-cli/src/lib.rs:188`, `:699-720`), and the base prompt lists `buzz reactions | add, remove` in the agent's command table (`crates/buzz-acp/src/base_prompt.md:13`). So a model _can_ deliberately react.

**But there is no encoded react-vs-reply etiquette.** The base prompt's response etiquette (`base_prompt.md:64-69`) is a two-way choice — publish a substantive message, or end the turn in silence ("silence is usually correct"; "Never publish a bare acknowledgement") — and never mentions reactions as a lighter-weight third option. The word "reaction" appears exactly once in the prompt (the command table row). No other prompt source in the repo adds reaction guidance (grep across `crates/buzz-agent`, `desktop/src-tauri/src/managed_agents`). Given that the loop postmortem's fix was banning content-free acknowledgement _messages_, the absence of "react instead" as sanctioned behavior is notable — the machinery exists, the etiquette doesn't.

(Separate feature: kind `24810` `KIND_HUDDLE_REACTION` is ephemeral emoji overlays inside voice huddles, unrelated to message acks.)

---

## 5. Presence

**Online/away/offline with a Redis TTL, one identical mechanism for humans and agents; agents additionally get richer product-level status.**

### Wire + storage

- Client/harness publishes kind `20001` with a **bare status string as content** ("online" / "away" / "offline"), no tags, over the WS path (ephemeral kinds are rejected by the HTTP bridge) — `crates/buzz-acp/src/lib.rs:69-91`.
- The relay intercepts kind 20001: "offline" deletes, anything else `SET buzz:{community}:presence:{pubkey} <status> EX 90` in Redis (`crates/buzz-relay/src/handlers/event.rs:794-828`; store at `crates/buzz-pubsub/src/presence.rs:16-45` — "TTL is 3x the 30s heartbeat interval so a single missed heartbeat doesn't cause presence flap"). The event then still fans out live to WS subscribers.
- **Queries are synthesized, not stored:** a REQ for kind 20001/40902 with authors is intercepted, answered from Redis, and returned as relay-signed synthetic kind-20001 events `p`-tagged with the subject (`crates/buzz-relay/src/api/bridge.rs:1951-2010+`).

### Agent presence

The harness publishes "online" at startup (`lib.rs:1509-1513`), re-publishes "online" every **60s** (`lib.rs:2302-2319`; comfortably inside the 90s TTL), and best-effort publishes "offline" on graceful shutdown under a timeout (`lib.rs:2695-2711`). A crashed harness just times out of Redis in ≤90s. `--no-presence` / `BUZZ_ACP_NO_PRESENCE` disables it (`config.rs:378`, `:1062`). Agents never send "away" — that state is computed client-side for humans from OS idle time (`desktop/src/features/presence/hooks.ts:18-22`, 30s heartbeat, auto-away via `getOsIdleSeconds`; manual away/offline preference persisted per pubkey).

### How agent state is surfaced

Presence is only the coarse layer; the desktop composes three signals for agents:

- **`AgentStatusBadge`** (`desktop/src/features/agents/ui/AgentStatusBadge.tsx:6-46`): process status × presence × working. Notably, "running + no presence after a 15s grace period" renders **"Starting…"** as a warning — presence-absence is used to detect a wedged agent. Working state renders a pulsing "Working" badge.
- **The unified "agent is working" signal** (`desktop/src/features/agents/agentWorkingSignal.ts:11-29`): primary source is owner-only encrypted **observer frames** (kind 24200 → `activeAgentTurnsStore`, carrying channel scope and a turn-start anchor); **bot typing (kind 20002) is the explicit fallback** when the observer stream is absent ("remote harness without relay observer, or frames not yet arrived"). Feeds sidebar channel badges, profile badges, composer activity bar, activity panel.
- **`BotActivityBar`** (`desktop/src/features/channels/ui/BotActivityBar.tsx:146-157`): "\<Agent\> is working" for one, "\<N\> agents working" / "\<Agent\> +N" for several, with rotating activity headlines.

---

## 6. Failure honesty — is decline distinguishable from deafness?

**Transiently yes, durably no. And a message dropped by the gates is indistinguishable from one never delivered.**

Three distinct silences:

1. **Never fired a turn** (author gate rejects — e.g. non-owner talking to an `owner-only` agent; or filter mismatch). The event is dropped with `continue` _before_ the 👀 add site (`crates/buzz-acp/src/lib.rs:2146-2170` gate vs `:2204-2216` reaction) — **zero visible signal, no explanation posted, only a harness debug log**. The sender cannot tell rejection from the agent being offline (except via the presence dot, which says nothing about willingness).
2. **Ran a turn and chose silence** (the sanctioned "nothing new to contribute" outcome, `base_prompt.md:67`). The human _did_ see 👀 appear, then 💬, then typing, then all of it vanish with no reply. During the turn, decline is visible; after the `ReactionGuard` cleanup (§2) removes both emoji, **no durable trace remains** — an hour later the thread looks exactly as if the agent was never addressed. There is no "processed ✓" marker, no declined-reaction, nothing.
3. **Failed.** Mid-flight failures retry invisibly (up to `MAX_RETRIES = 10`, `crates/buzz-acp/src/queue.rs:30`, exponential 5s→300s backoff). Only on **dead-letter** does the agent post a plain, channel-visible kind-9 notice into the triggering thread (`lib.rs:3031-3052` `spawn_failure_notice` → `pool.rs:3572` `post_failure_notice`): "⚠️ I couldn't process the last request (the turn exceeded the maximum duration…)" / "…after multiple retries…" / "…authentication failed. Please re-authenticate the CLI…" (`lib.rs:3125`, `:3143`, `:3161`, `:3177`). A model-refused turn (`StopReason::Refusal`) is only logged (`pool.rs:3153-3155`) — no channel notice.

The _owner_ (only) can distinguish all cases after the fact via the encrypted telemetry side-channels: kind-24200 observer frames (opt-in, default **off** — `config.rs:475`) and durable per-turn NIP-AM metrics (kind 44200, encrypted to the owner, excluded from open subscribe filters — `crates/buzz-core/src/kind.rs:152-154`, `:485`; published from `pool.rs:3407-3470`). Channel members get nothing.

---

## 7. Multi-agent noise control

**No damping at the source; aggregation-only damping at the display.**

- **Harness side: none.** Each `buzz-acp` process independently publishes its own 👀, 💬, typing, and presence. Three agents mentioned in one message → three 👀 reactions, three 💬 reactions, and three parallel typing streams, each republishing every 3s. No cross-agent coordination, no suppression, no jitter, no "one indicator per channel" rule anywhere in `crates/buzz-acp`.
- **Client side: aggregation, not suppression.** Everything stays visible but is folded:
  - Typing entries are keyed per `(pubkey, thread)` and all render — stacked avatars plus "A and B are typing..." / "A, B, and N others are typing..." (`desktop/src/features/messages/ui/TypingIndicatorRow.tsx:38-52`).
  - **Agent typing is routed away from the human typing row entirely**: `useChannelActivityTyping` splits typing entries by whether the pubkey is a channel-member agent (`desktop/src/features/channels/ui/useChannelActivityTyping.ts:88-104`); humans go to the "is typing..." row (`ChannelScreen.tsx:959` passes `humanTypingPubkeys`), agents are mirrored into the working signal (`useChannelActivityTyping.ts:106-121` → `reportChannelBotTyping`, `agentWorkingSignal.ts:106-131`) and rendered as the collapsed `BotActivityBar` — "N agents working" (`BotActivityBar.tsx:146-149`). Thread-scoped agent typing lights only thread surfaces, never channel-level badges (`useChannelActivityTyping.ts:19-23`).
  - The working signal dedups observer-vs-typing per channel (observer wins, typing only fills channels the observer doesn't cover — `agentWorkingSignal.ts:147-159`) and merges agent sets per channel (`:219-254`).

So the noise-control philosophy is: let every agent emit; classify agents (channel-membership-derived, not `is_agent`-derived, here) and compress their ambient signals into one product surface, keeping the human "typing" affordance human-only.

---

## Unverified / not found

Claims I looked for and could not ground in this tree, or deliberately did not verify:

- **Why the read cursor is per-installation rather than per-member** beyond what NIP-RS's Motivation/Privacy sections state — the shallow clone has no commit history or design docs beyond the NIP itself.
- **Whether any client surfaces "agent read up to here"** from the 👀 reaction (e.g. a seen-summary). I found no such UI, but I did not exhaustively read every desktop feature; the negative is scoped to greps for seen-by/read-receipt terms and the readState/ and messages/ feature dirs.
- **Mobile (Flutter) and `web/`/`admin-web/` behavior** — I read only the Tauri desktop client; typing TTLs, presence heartbeats, and read-state behavior on the other clients are unexamined.
- **Runtime behavior of any of this** — everything here is static source reading; nothing was executed. In particular, I did not verify that the relay actually enforces the 90s presence TTL under load or that the 👀-stale races occur as documented.
- **The claim that "away" is fully unused by agents in every code path** — verified for the buzz-acp harness (only "online"/"offline" literals appear at `lib.rs:1510`, `:2315`, `:2704`); other harness entry points (e.g. `buzz-agent` self-hosted mode) were not swept for presence writes.
- **`KIND_PRESENCE_SNAPSHOT` (40902) production semantics** — the CLI queries it (`crates/buzz-cli/src/commands/users.rs:246-277`) and the bridge intercepts it alongside 20001 (`bridge.rs:1963-1971`), but I did not trace whether any code path ever _emits_ a stored 40902 event versus it existing purely as a query-shape alias.
- **Whether model-chosen reactions actually occur in practice** — the CLI capability exists and is advertised in the prompt table, but with no etiquette text and no examples, actual usage frequency is unknowable from source.
