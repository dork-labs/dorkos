---
title: 'Buzz — the conversational behavior model: how an agent decides to speak'
date: 2026-07-27
type: external-source-review
status: active
tags:
  [buzz, nostr, group-chat, multi-agent, trigger-policy, loop-prevention, rooms, agent-etiquette]
feature_slug: room-participation
---

# Buzz — Conversational Behavior Model (deep technical research)

**Subject:** `github.com/block/buzz` — Block's open-source agent-in-chat workspace.
**Method:** full shallow clone read at commit `d500c2d5cf5d9aabe0ca4ebebfcafdbe5f5b7fd3` (2026-07-27), source read directly (WebFetch truncates quotes; the clone was used for all citations).
**Scope note:** This deliberately does NOT re-derive transport/rooms/roster/read-cursors/invites/roles/NIP-OA/rate-limits — those are already covered in `research/20260727_buzz-protocol-capability-spike.md` (anchor `654f3849`) and `research/20260727_agent-identity-in-communities.md`. This document covers only the **conversational behavior model**: how an agent decides to speak and what it says.

Permalink base for all citations:
`https://github.com/block/buzz/blob/d500c2d5cf5d9aabe0ca4ebebfcafdbe5f5b7fd3/<path>#L<line>`

---

## 0. Where the behavior lives — the architectural shape

Buzz's relay (`crates/buzz-relay`) has **no opinion about agent behavior**. It is a Nostr relay: it stores and routes signed events. All response policy lives in a separate, per-agent **harness process** called `buzz-acp` (`crates/buzz-acp`), which:

1. connects to the relay as its own Nostr identity,
2. subscribes to channels,
3. filters inbound events through a deterministic gate chain,
4. spawns and drives an **ACP** (Agent Client Protocol, JSON-RPC over stdio) subprocess — by default `goose acp`, but also `claude-agent-acp`, `codex-acp`, or Buzz's own `buzz-agent`.

`ARCHITECTURE.md` describes it as: agents connect via buzz-acp, maintain a pool of 1–32 agent instances, discover channels via REST, and respond to `@mention` events, with each channel queued separately so at most one prompt is in flight per channel.

So the mental model is: **one OS process per agent, each independently watching the relay.** There is no server-side agent scheduler. This is the single most important structural fact, and it explains most of what follows (especially §2).

The desktop app (Tauri) is the supervisor: `desktop/src-tauri/src/managed_agents/runtime.rs:569` does `std::process::Command::new(&resolved_acp_command)` (default `buzz-acp`, `desktop/src-tauri/src/managed_agents/types.rs:775`) and configures it **entirely via environment variables** — that file contains zero `.arg()` calls. It sets `BUZZ_ACP_AGENTS`, `BUZZ_ACP_MULTIPLE_EVENT_HANDLING="steer"`, `BUZZ_ACP_DEDUP`, and `BUZZ_ACP_RESPOND_TO`/`BUZZ_ACP_RESPOND_TO_ALLOWLIST` (via `build_respond_to_env()`, `runtime.rs:380-421`). It notably does **not** set `BUZZ_ACP_SUBSCRIBE` or `BUZZ_ACP_PERMISSION_MODE`, so those fall through to clap defaults (`mentions` and `bypass-permissions`).

---

## 1. RESPONSE POLICY — when does an agent speak?

**Headline: there is no LLM-based "should I respond?" gate anywhere in Buzz.** Confirmed by repo-wide grep for `should_respond|should-respond|relevance_(score|judg)|is_relevant|worth[_ ]responding|engagement_score|response_gate` across all `.rs`/`.ts`/`.tsx`/`.md` — zero hits. The invocation decision is 100% deterministic. What _is_ LLM-judged is the separate, downstream question of whether the agent publishes anything at the end of its turn (§1.5).

The decision splits into **two independent questions**, and conflating them is the mistake to avoid:

- **Q1 — "Do I run a turn?"** Deterministic gate chain, five layers, all in `buzz-acp`.
- **Q2 — "Having run a turn, do I say anything?"** Left entirely to the model, steered by prompt text.

### 1.1 The five-layer deterministic gate chain

Every inbound relay event passes through these in order. Any layer can drop it.

**Layer 1 — relay subscription filter (server-side pre-filter).**
The harness sends a NIP-01 `REQ` per channel. When mention-mode is on, the REQ carries a `#p` tag equal to the agent's own pubkey, so the relay never even delivers non-mentioning messages.

`crates/buzz-acp/src/relay.rs:3151-3158`:

```
/// Send a NIP-01 REQ for a channel, built from a [`ChannelFilter`].
///
/// - `kinds` is included only when `filter.kinds` is `Some`; `None` = wildcard.
/// - `#p` is included only when `filter.require_mention` is `true`.
/// - `#h` is always included (channel-scoped subscription).
/// - On first subscribe (`since` is `None`) adds `since=now` to avoid replaying
///   history. On reconnect (`since` is `Some`) subtracts [`SINCE_SKEW_SECS`].
```

`relay.rs:3180-3184`:

```rust
    // #p — only when require_mention is true.
    if filter.require_mention {
        req_filter.insert("#p".into(), json!([agent_pubkey_hex]));
    }
```

Also note `since=now` on first subscribe — **an agent joining a channel sees no history at all and never back-fills.** It only ever reacts to events arriving after it connected.

**Layer 2 — self-suppression (`ignore_self`).**
`crates/buzz-acp/src/lib.rs:2028`:

```rust
if config.ignore_self && buzz_event.event.pubkey.to_hex() == pubkey_hex {
    tracing::debug!(channel_id = %buzz_event.channel_id, "dropping self-authored event");
    continue;
}
```

Default true (`config.rs:1055`: `ignore_self: !args.no_ignore_self`), disabled with `--no-ignore-self` / `BUZZ_ACP_NO_IGNORE_SELF`. **It suppresses only the agent's own events. It does nothing about other agents.**

**Layer 2.5 — owner control commands (consumed, never forwarded).**
Before the author gate, three literal commands from the owner are intercepted and consumed: `!shutdown`, `!cancel` (`lib.rs:2065-2089`), `!rotate` (`lib.rs:2103-2134`). Predicate (`lib.rs:2719-2727`):

```rust
fn is_owner_control_command(
    event: &nostr::Event, kind_u32: u32, command: &str, agent_pubkey_hex: &str,
) -> bool {
    kind_u32 == KIND_STREAM_MESSAGE
        && event.content.trim() == command
        && event_mentions_agent(event, agent_pubkey_hex)
}
```

`!cancel` kills an in-flight turn; `!rotate` starts the next turn with a fresh ACP session. Both are consumed by the harness (`continue` — never reach the model). Nice pattern: **in-channel out-of-band control verbs, owner-authenticated by pubkey.**

**Layer 3 — the inbound author gate (`author_allowed`) — the security boundary.**
`crates/buzz-acp/src/lib.rs:218-258`. Doc comment verbatim:

```
/// Inbound author gate decision: does this author's event fire a turn?
///
/// Coarse security policy applied before subscription rules. Both `OwnerOnly`
/// and `Allowlist` accept the owner and same-owner siblings; `Allowlist`
/// additionally accepts the explicit external pubkey list.
///
/// # DM hardening (`is_dm`)
///
/// Clients auto-p-tag every DM participant, so in a DM *any* participant's
/// message looks like a mention and would fire a turn. Combined with
/// agent-initiated DMs (the agent can be asked to DM a third party), that
/// turns `anyone`/`allowlist` modes into transitive access grants: whoever
/// lands in a DM with the agent can prompt it. To close that hole, when
/// `is_dm` is true only the owner and cryptographically verified same-owner
/// siblings may fire a turn — the explicit allowlist and `anyone` mode do
/// NOT apply inside DMs. `Nobody` still drops everything. Callers must
/// resolve `is_dm` fail-closed: unknown channel type ⇒ treat as DM.
```

Body:

```rust
async fn author_allowed(
    respond_to: &RespondTo, allowlist: &HashSet<String>, author: &str,
    is_dm: bool, owner_cache: &OwnerCache, rest_client: &relay::RestClient,
) -> bool {
    if is_dm {
        return match respond_to {
            RespondTo::Nobody => false,
            _ => is_owner_or_sibling(author, owner_cache, rest_client).await,
        };
    }
    match respond_to {
        RespondTo::Anyone => true,
        RespondTo::Nobody => false,
        RespondTo::OwnerOnly => is_owner_or_sibling(author, owner_cache, rest_client).await,
        RespondTo::Allowlist => {
            allowlist.contains(author)
                || is_owner_or_sibling(author, owner_cache, rest_client).await
        }
    }
}
```

Call site: `lib.rs:2147-2173`. **Default mode is `OwnerOnly`** (`config.rs:88-101`). "Sibling" = a pubkey whose kind:0 profile carries a NIP-OA `auth` tag naming the same owner — i.e. another agent owned by the same human. `is_owner_or_sibling` (`lib.rs:192-216`) caches results (256-entry cache, cleared wholesale on overflow) and **fails closed** on unknown owner / profile-fetch timeout (2000ms, `lib.rs:304-308`).

`is_dm_channel` (`lib.rs:273-287`) is explicitly fail-closed:

```
/// Fail-closed: if the fetch fails or times out, the channel is treated as a
/// DM for this event and the result is NOT cached, so a later event retries
/// the fetch instead of pinning a mis-classification.
```

**Layer 4 — subscription rule matching (`filter::match_event`) — first match wins, fail closed.**
`crates/buzz-acp/src/filter.rs:368-460`. Per rule, in order: channel scope → kind → mention → optional expression.

The **mention test is a pure Nostr `p`-tag equality check — never a content/regex/name match** (`filter.rs:388-398`):

```rust
        // 3. Mention check — look for a `p` tag whose first element equals
        //    agent_pubkey_hex. ...
        if rule.require_mention {
            let mentioned = event.tags.iter().any(|tag| {
                let s = tag.as_slice();
                s.first().map(|k| k.as_str()) == Some("p")
                    && s.get(1).map(|v| v.as_str()) == Some(agent_pubkey_hex)
            });
            if !mentioned { continue; }
        }
```

Identical logic in `lib.rs:2712-2717` (`event_mentions_agent`). This is why `base_prompt.md:41` warns: _"Use the person's **exact full display name** after `@` (e.g., `@Will Pfleger`, not `@Will`). Partial names fail silently."_ — the **client** resolves `@Name` → pubkey and emits the `p` tag; a partial name resolves to nothing and the tag never exists.

Optional `filter` field is an **evalexpr** boolean expression. Variables (`filter.rs:249-263`):

```
/// | Name         | Type   | Source                    |
/// | `content`    | string | `event.content`           |
/// | `author`     | string | `event.pubkey` (hex)      |
/// | `kind`       | int    | `event.kind`              |
/// | `channel_id` | string | channel UUID              |
/// | `timestamp`  | int    | `event.created_at`        |
/// Also registers `str_contains`, `str_starts_with`, `str_ends_with`, `str_len`
```

Sandboxed: `MAX_EXPR_LEN` 4096 bytes, 100ms hard timeout, max 4 concurrent blocking evals. **Any** error/timeout on a matching rule returns `None` for the whole event — no fall-through to later rules (`filter.rs:357-363`), and after `MAX_CONSECUTIVE_TIMEOUTS = 5` a rule is permanently disabled for the process lifetime. Fail-closed = silently mute.

**Layer 5 — the model itself.** Everything above only decides _invocation_. See §1.5.

### 1.2 The three subscribe modes

`SubscribeMode` (`config.rs:50-55`): `Mentions | All | Config`. Default `mentions` (`--subscribe` / `BUZZ_ACP_SUBSCRIBE`).

- **`mentions`** (default) — one synthesized rule (`lib.rs:1439-1457`):
  ```rust
  vec![SubscriptionRule {
      name: "mentions".into(),
      channels: filter::ChannelScope::All("all".into()),
      kinds: config.kinds_override.clone().unwrap_or_else(|| {
          vec![KIND_STREAM_MESSAGE, KIND_WORKFLOW_APPROVAL_REQUESTED, KIND_STREAM_REMINDER]
      }),
      require_mention: !config.no_mention_filter,
      filter: None,
      ...
      prompt_tag: Some("@mention".into()),
  }]
  ```
  Note it fires on three kinds, not just chat: messages, **workflow approval requests**, and **reminders**.
- **`all`** — `require_mention: false`, wildcard kinds (`lib.rs:1458-1469`). The agent wakes on **every** event in every subscribed channel. There is no throttle, no batching window, and no relevance filter — pure firehose. This is the "always speak" configuration and it is clearly not the intended default.
- **`config`** — load ordered rules from a TOML file (`--config`, default `./buzz-acp.toml`).

`--no-mention-filter` / `BUZZ_ACP_NO_MENTION_FILTER` flips mentions-mode into "everything in my channels" without switching to `all`.

### 1.3 The rules file (the only per-channel surface)

`TomlConfig` (`config.rs:1129-1133`) deserializes one key: `rules: Vec<SubscriptionRule>`. Real fixture (`config.rs:1892-1904`):

```toml
[[rules]]
name = "catch-all"
channels = "all"
kinds = [9]
require_mention = false
```

`SubscriptionRule` fields (`filter.rs:82-114`): `name`, `channels` (`"all"` | `["<uuid>", ...]`), `kinds` (empty = wildcard), `require_mention`, `filter`, `prompt_tag`. Validation at load: max 100 rules, unique non-empty names, filter ≤ 4096 bytes and eagerly parsed (syntax errors fail startup, not runtime).

**Gotcha worth stealing the lesson from:** rules are consumed by two paths with _different_ combination semantics. `filter::match_event` is first-match-wins. But `config::resolve_channel_filters` (`config.rs:1261-1296`) — which builds the actual relay subscription — **unions** kinds across all matching rules and sets `require_mention = false` if _any_ matching rule has it false. So the live subscription can be strictly broader than the dispatch logic. Two sources of truth for one concept.

Also: `crates/buzz-acp/README.md:238-242` documents a `[channel.<uuid>]` TOML form that `load_rules` cannot parse at all. Documented-but-nonexistent config.

### 1.4 Scope of the config surface

- **Per agent process (global):** every knob in §8 except the rules file. Including `respond_to`.
- **Per channel:** ONLY via `SubscriptionRule.channels` in `config` mode. And the desktop app never uses config mode.
- **Desktop UI reality:** `desktop/src/features/agents/ui/RespondToField.tsx` is an agent-level dropdown (Only me / Anyone / Allowlist). There is an `EditRespondToDialog.tsx` reachable from the channel Members sidebar (`MembersSidebar.tsx:643`) that _looks_ per-channel but writes the agent's single global `respond_to` field. **Per-channel response policy is not implemented in Buzz.** Channel-level UI controls membership only.

### 1.5 The publish decision — LLM-judged, prompt-steered

Layers 1-4 decide whether a turn _runs_. Whether the turn _produces a channel message_ is decided by the model, instructed by `crates/buzz-acp/src/base_prompt.md:64-70`. Verbatim, the operative rules:

> - Respond promptly to @mentions. Be direct — no preamble. Name what you did, what you found, or what you need.
> - **If your turn produced anything worth knowing, you MUST publish it.** Use `buzz messages send`. Your reasoning and tool calls are invisible — a result, an answer, a deliverable, a decision, a blocker, or a question you need answered exists only if you published it. Work or an answer that someone asked you for always counts. Ending that kind of turn without a message is a silent failure.
> - **If a human asked you something, you MUST reply to them** — even if the reply is only that you have nothing to add or nothing to do. Never leave a person waiting on you.
> - **Otherwise, publishing is optional and silence is usually correct.** When a message leaves you nothing new to contribute, end the turn without publishing. That is a success, not a failure.
> - **After a context compaction or session restart, resume silently** — rebuild state from your todos, memory, and the thread, and never post a message announcing the compaction, summarizing what was lost, or asking how to proceed.
> - **Never publish a bare acknowledgement.** A message whose only content is confirming, accepting, agreeing, aligning, signing off, or announcing your own silence adds nothing — and it re-triggers everyone you mention. Prohibited: "Got it", "Confirmed", "Acknowledged", "Clear and noted", "Aligned", "Standing by", "Parked", "I won't reply again", and any variation. If your draft contains nothing beyond acknowledgement, send nothing. If you are tempted to announce that you are done replying, that itself is the message not to send.

There is no tool the harness forces; **the agent publishes by shelling out to `buzz messages send`.** Silence is the default outcome of a turn — the harness posts nothing on the agent's behalf.

---

## 2. MULTIPLE AGENTS IN ONE CHANNEL

**Supported, and explicitly uncoordinated.** `VISION.md:169`:

> "A persona bundles a model and a system prompt. A team is a named group of personas — deploy Ralph for code review, Scout for research, Reviewer for crossfire."

But `crates/buzz-agent/README.md:262`:

> "**Not a router.** No agent-to-agent, no fan-out, no orchestration. One model. One loop."

**There is no orchestrator, no bidding, no arbitration, no turn-taking between agent processes. Not implemented in Buzz.** Each `buzz-acp` process independently evaluates its own gate chain against the shared relay stream.

The de-facto arbitration is **addressing**: with `require_mention` on (the default), only the agents whose pubkey appears in a `p` tag wake up. A message tagging one agent wakes exactly one. A message tagging three wakes three, and all three answer concurrently with no awareness of each other's in-flight work. `ARCHITECTURE.md` confirms the only concurrency invariant is per-channel-per-process: "Each channel queues mentions separately, ensuring at most one prompt is in-flight per channel" — that's one process's own serialization, not cross-agent.

So: **mention-addressing is the arbitration mechanism, and it is entirely on the human to aim correctly.** This is the design's biggest gap and the one we should improve on.

---

## 3. AGENT-TO-AGENT MESSAGING AND LOOP PREVENTION

Agents can absolutely address each other: same `p`-tag mechanism, and the author gate _deliberately_ admits siblings (same-owner agents, NIP-OA verified). `base_prompt.md:60` explicitly contemplates delegation: _"All replies and delegations — including task assignments to other agents — go to the **same channel where you were tagged**."_

### 3.1 The runaway loop incident — read this section twice

`docs/welcome-kickoff-silent-failures.md` is a first-hand postmortem of a production agent-to-agent reply storm. It is the single most valuable artifact in the repo for us.

Observed on the Codex runtime, 21+ replies deep (`:157-163`):

> **Bumble:** `@Fizz` parked; no further replies from me until there's work.
> **Honey:** `@Fizz` understood. I won't reply again unless there's a task for me.
> **Fizz:** `@Honey` `@Bumble` acknowledged — stay parked until `@morgan` brings a real task.
>
> **The content was the tell: every agent was trying to end the conversation, and announcing it is what kept it alive.** The agents were not malfunctioning — they were complying exactly. The loop was _correct_ behavior given the prompt.

Root cause (`:167-183`) — two prompt rules that were each individually correct composed into a perpetual motion machine:

> 1. _"**Every turn that processes a user message MUST publish a reply.** […] A turn that ends without a published message is a silent failure."_
> 2. _"When you finish delegated work, you MUST `@mention` the delegator […]. This is the #1 cause of stalled collaboration."_
>
> Rule 1: _always speak_. Rule 2: _when you speak, tag whoever tagged you_. On a mutual mention the circuit closes and never opens.

And the aggravating factor (`:180-183`):

> The Welcome kickoff was the worst case: the opener says _"Don't start any work yet"_, so teammates were told they **must** reply and that there is **nothing to report** — stripping away every substantive thing a reply could contain. The only output satisfying rule 1 was a content-free acknowledgement. The kickoff didn't just permit the loop; its instructions selected for it.

The generalizable insight (`:213-221`):

> **"Don't get into a loop" is not a rule an agent can follow.** A loop is a global property of a conversation; each agent sees only its own turn, and every individual reply looks locally reasonable — which is why the sign-offs read as polite rather than broken. The rule had to become a **local, per-turn test**: _does this add information the thread doesn't have?_ An acknowledgement is definitionally not new information, which makes "no bare acknowledgements" the checkable form of the intent.
>
> A soft caveat would also have failed: _"you may end the turn"_ sitting next to _"**MUST** publish a reply"_ leaves a literal model correctly following the stronger instruction. The mandate had to be **narrowed**, not exception-ed.

### 3.2 What actually shipped: prompt-only

The fix (2026-07-18) was entirely in `base_prompt.md` — the §1.5 rules above, plus narrowing the callback rule to completed work only (`base_prompt.md:47-48`):

> - When you **finish delegated work**, you MUST `@mention` the delegator in the message that reports the result, deliverable, or blocker. This is the #1 cause of stalled collaboration.
> - This applies to **completed work only.** Do not `@mention` to accept an assignment, confirm receipt, or close a loop conversationally. If you have nothing to report yet, say nothing and report when you do.

Plus mention hygiene (`base_prompt.md:43`):

> - Only `@mention` when you need their attention. Don't mention in narrative (e.g., "coordinating with Duncan" — no `@`). Naming someone while talking _about_ them is narrative — "waiting on @morgan", "until @morgan brings work", "I'll loop in @morgan later". Drop the `@`. Every mention sends a notification; a mention nobody needs to act on is a false alarm.

Verification status is honest and weak (`:152-155`): _"prompt hardening landed 2026-07-18. Verified once manually (14:26 run: 3 replies, intros, stop). One good observation, not proof. Re-verify on Codex specifically."_

### 3.3 Hard loop prevention: NOT IMPLEMENTED

`docs/welcome-kickoff-silent-failures.md:227-237`, verbatim:

> Prompt-only means prose-compliance-only, and Codex is proof models don't reliably comply. There is still **no reply-depth counter, hop limit, cooldown, or agent-to-agent budget anywhere in the path.** Existing guards that don't help:
>
> | Guard                                     | Why not                                                                                                                                                                                       |
> | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | `ignore_self` (`lib.rs:1864`)             | Blocks self-replies only. The _only_ loop guard, and A→B→A is exactly what it misses.                                                                                                         |
> | Author gate (`respond_to`)                | **Admits siblings by design** — `is_owner_or_sibling` (`lib.rs:166`) verifies same-owner agents via NIP-OA. It's an _admission_ mechanism; a loop needs _termination_. No setting stops this. |
> | `max_turns_per_session` (`config.rs:372`) | Defaults 0 = disabled; it's session rotation for context hygiene, not a reply brake.                                                                                                          |
> | Queue caps (`queue.rs:24`)                | Backpressure on _pending_ events. A ping-pong is never backed up.                                                                                                                             |
> | `closerMarker`                            | Idempotency for the client-authored closer only; never observes agent replies.                                                                                                                |

The proposed-but-unbuilt design (`:239-247`):

> Candidate: **consecutive agent-to-agent reply budget** — count unbroken agent-authored turns in a thread; past N, drop the trigger. A human message resets it. Set N high (~6–10) so it never fires on healthy work — a circuit breaker, not a policy. `resolve_reply_anchor` deliberately allows deep agent-only nesting, so a low cap would truncate legitimate coordination.
>
> **A too-aggressive breaker manufactures §3.** A depth counter cannot tell a loop from a productive chain; dropping a good reply produces exactly the unexplained silence this doc is otherwise about. Hence: prompt primary, breaker high.

**No ancestry check, no hop counter, no bot-message filtering, no cooldown. Confirmed absent.**

Note the unrelated-but-adjacent `CIRCUIT_BREAKER_*` in `lib.rs:1008-1102` — that throttles respawning a _crashing subprocess_ (3 crashes / 60s → 5 min cooldown), not reply loops. And `ARCHITECTURE.md:244` documents loop prevention for the **workflow** engine only: _"Workflow loop prevention: workflow execution kinds (46001–46012), relay-signed messages with `buzz:workflow` tag, and `KIND_GIFT_WRAP` are excluded from triggering workflows."_ — i.e. Buzz solved this for automations and not for agents.

---

## 4. CONTEXT CONSTRUCTION — what the agent actually sees

### 4.1 Section order

`crates/buzz-acp/src/queue.rs:1386-1394` (`format_prompt` doc):

```
/// Produces a stable prompt with these sections (in order):
/// 0. `[Base]` — base prompt (only for legacy agents without systemPrompt support)
/// 1. `[System]` — system prompt (only for legacy agents without systemPrompt support)
/// 2. `[Agent Memory — core]` — if agent core memory is set
/// 3. `[Context]` — scope, channel name, and contextual hints for the agent
/// 4. `[Thread Context]` or `[Conversation Context]` — if fetched
/// 5. `[Event]` / `[Buzz events]` — the triggering event(s)
```

For modern agents (ACP `protocol_version >= 2`), `[Base]`/`[System]`/`[Team Instructions]`/memory/canvas ride in the ACP `session/new` `systemPrompt` (assembled in `pool.rs:1190-1274` as `[Workspace]` → `[Base]` → `[System]` → `[Team Instructions]` → `[Agent Memory — core]` → `[Channel Canvas]`), so the per-turn user message **starts at `[Context]`** (test assertion `queue.rs:2442`: `assert!(prompt.starts_with("[Context]"));`).

`format_prompt` returns `Vec<String>` — one string per section rather than a joined blob — specifically so the observer UI can trim oversized sections in place (`queue.rs:1396-1401`).

### 4.2 The `[Context]` block, verbatim

Built by `format_context_hints` (`queue.rs:1233-1314`). Three variants.

Channel (`queue.rs:1303-1307`):

```
[Context]
Scope: channel
Channel: {name} (#{channel_uuid})
Hint: Use `buzz messages get --channel <UUID>` for recent messages if needed.
```

Thread (`queue.rs:1286-1291`):

```
[Context]
Scope: thread
Channel: {name} (#{channel_uuid})
Thread root: {root}
```

DM (`queue.rs:1261-1266`):

```
[Context]
Scope: dm
Channel: {name} (#{channel_uuid})
{ctx_hint}
```

**What is NOT in `[Context]`:** no channel member roster, no participant list, no channel purpose/topic description, no wall-clock time, and not even the agent's own name. This is a notable gap — an agent has no idea who else is in the room unless it shells out to `buzz channels members`.

Reply-destination instruction, appended conditionally (`queue.rs:1149-1157`):

```
IMPORTANT: For ordinary replies in this turn, use `--reply-to {event_id}` on `buzz messages send` so the conversation stays threaded. If the human explicitly asks for a channel-root, top-level, or broadcast post, send that message without `--reply-to`. If the requested destination is ambiguous, ask before sending.
```

New-top-level variant (`queue.rs:1164-1171`):

```
IMPORTANT: This is a new top-level message. For ordinary replies in this turn, use `--reply-to {event_id}` on `buzz messages send` — the triggering message is the thread root. Do NOT reply into any other (older) thread. If the human explicitly asks for a channel-root, top-level, or broadcast post, send that message without `--reply-to`.
```

### 4.3 History window

**Not the full channel. A small, conditional, pre-fetched window.**

`config.rs:364-368`:

```rust
/// Maximum number of context messages to include for thread replies and DMs.
/// Set to 0 to disable automatic context fetching. Max 100.
#[arg(long, env = "BUZZ_ACP_CONTEXT_MESSAGE_LIMIT", default_value_t = 12,
      value_parser = clap::value_parser!(u32).range(0..=100))]
pub context_message_limit: u32,
```

**Default 12 messages.** Routing (`pool.rs:2556-2582`, `fetch_conversation_context`):

- triggering event has a thread root → `fetch_thread_context` (root event + all `#e=root` replies, limited)
- DM, non-reply → `fetch_dm_context` (last N in the DM, reversed to chronological)
- **plain top-level channel message → `None`. Zero history.** The agent sees only the triggering message plus the `buzz messages get` hint.

Render header (`queue.rs:1317-1349`):

```
[{Thread Context|Conversation Context} ({n} of {total} messages{, truncated})]
[1] {actor} ({timestamp}): {content}
```

### 4.4 Participant labeling — and the human/agent marker that isn't shown

`format_prompt_actor` (`queue.rs:1042-1065`):

```rust
fn format_prompt_actor(pubkey: &str, profile_lookup: Option<&PromptProfileLookup>) -> String {
    match resolve_prompt_label(pubkey, profile_lookup) {
        Some(label) => format!("{label} ({pubkey})"),
        None => pubkey.to_string(),
    }
}
```

The `[Event]` `From:` line is richer (`queue.rs:1104-1107`): `{label} (npub: {npub}, hex: {hex})`, falling back to `{npub} (hex: {hex})`.

Buzz _knows_ who is an agent — `PromptProfile.is_agent` (`queue.rs:1001-1009`):

```rust
/// True when this pubkey's kind:0 profile carries a NIP-OA `auth` tag,
/// i.e. it is an owned agent rather than a human. Used to gate reply-anchor
/// flattening (UX routing heuristic, not a security boundary).
pub is_agent: bool,
```

detected by `profile_event_is_agent` (`pool.rs:2631-2647`) checking for a 4-element `["auth", owner_pk, conditions, sig]` tag.

**But `is_agent` is never rendered into the prompt.** No "(agent)" / "(human)" marker appears in `[Event]` or history. It is used _only_ internally for reply-anchor routing. So the model cannot tell from its input whether the entity that just messaged it is a person or a bot — which is precisely the discrimination it needs to avoid §3's loop. Strong candidate for "deliberately avoid": **they compute the signal and then withhold it from the model.**

### 4.5 Agent memory injection

`[Agent Memory — core]` comes from `engram_fetch.rs` (NIP-AE, kind 30174, NIP-44 encrypted between agent and owner). Header const `engram_fetch.rs:21`: `const SECTION_LABEL: &str = "Agent Memory — core";`. When absent, an onboarding nudge is injected instead (`engram_fetch.rs:27-29`):

```
"No core memory found. Use `buzz mem set core \"…\"` to create one (it will hold your identity, rules, and goals across sessions). Ask your user about yourself."
```

The content is entirely agent-authored. Guidance in `base_prompt.md:104-110` — keep `core` under ~10 KB against a 65,535-byte hard limit, push durable detail to cold `mem/<slug>` slugs, evict completed work.

---

## 5. TURN-TAKING AND CONCURRENCY

Strong area. This is the most mature part of the design.

**Per-channel serialization.** `EventQueue` (`queue.rs`) holds per-channel deques plus an `in_flight_channels` set. At most one prompt in flight per channel per agent. Constants: `MAX_PENDING_PER_CHANNEL = 500` (`queue.rs:24`), `MAX_BATCH_EVENTS = 50` (`:26`), `MAX_RETRIES = 10` (`:29`), `BASE_RETRY_DELAY_SECS = 5` / `MAX_RETRY_DELAY_SECS = 300` (`:32,35`) with ±20% jitter. Flush picks the channel with the oldest pending event (FIFO fairness) and drains up to 50 into one prompt. In-flight entries carry an auto-expiry deadline (~7300s) so an orphaned turn can't wedge a channel forever.

**There is no debounce window.** Events dispatch as soon as the channel is free. Batching happens only because events accumulate while a turn is running, not because of a deliberate wait.

**Mid-generation arrival — four modes.** `MultipleEventHandling` (`config.rs:64-86`), verbatim doc comments:

```rust
/// Queue new events while a turn is in-flight. Deliver after current turn
/// completes. Existing behavior — zero code change in this path.
Queue,
/// Cancel the in-flight turn and re-dispatch a merged prompt that frames
/// the new events as a **steering message** — one that arrived while the
/// agent was working, to be woven into the in-progress task rather than
/// treated as a replacement. Fires for any author the inbound author gate
/// admits (owner ∪ allowlist ∪ siblings). This is the default mid-turn
/// delivery path. Requires DedupMode::Queue.
Steer,
/// Cancel the in-flight turn and re-dispatch a merged prompt combining
/// the original events with the new ones, framed as a **supersede** (the
/// new request replaces the old), for ANY new @mention.
/// Requires DedupMode::Queue.
Interrupt,
/// Cancel the in-flight turn only when the new @mention is from the agent
/// owner (resolved via owner_cache). All other authors queue normally.
/// Requires DedupMode::Queue.
#[value(name = "owner-interrupt")]
OwnerInterrupt,
```

**Default is `steer`, not `queue`** (`config.rs:353-359`). Dispatch (`lib.rs:2742-2756`):

```rust
fn mode_gate_signal(handling: MultipleEventHandling, author_hex: &str, owner: Option<&str>)
    -> Option<ControlSignal> {
    match handling {
        MultipleEventHandling::Queue => None,
        MultipleEventHandling::Steer => Some(ControlSignal::Steer),
        MultipleEventHandling::Interrupt => Some(ControlSignal::Interrupt),
        MultipleEventHandling::OwnerInterrupt => match owner {
            Some(o) if author_hex == o => Some(ControlSignal::Interrupt),
            _ => None,
        },
    }
}
```

**Two-tier steer.** First it tries a _non-cancelling_ native steer via the goose ACP extension `_goose/unstable/session/steer` (`try_native_steer`, `lib.rs:2780+`). If the agent rejects it (including `-32601 method_not_found` from agents lacking the extension), it falls back to universal **cancel + merge + re-prompt**. During the native-steer ack window the queued event is withheld in a side table so it isn't double-delivered.

**Merge framing** (`queue.rs:1566-1609`) — the model is explicitly told what happened:

```rust
None | Some(CancelReason::Steer) => MergeFraming {
    prior_header: "[What you were working on]",
    new_header_single: "[New message — arrived while you were working]",
    new_header_multi_prefix: "[New messages — arrived while you were working",
    closing_note: "Note: A new message arrived while you were working. Continue your \
         in-progress work and incorporate the new message if it's relevant; if it's \
         unrelated, you may briefly acknowledge it and carry on.",
},
Some(CancelReason::Interrupt) => MergeFraming {
    prior_header: "[Previous request — interrupted before completion]",
    new_header_single: "[New request — supersedes previous]",
    new_header_multi_prefix: "[New request — supersedes previous",
    closing_note: "Note: The previous request was interrupted. Please address the new \
         request.\nIf the new request is unrelated to the previous one, you may \
         briefly acknowledge the interruption.",
},
```

Non-cancelled multi-event batches use `[Buzz events — {N} events]` (`queue.rs:1543`); single non-cancelled uses `[Buzz event: {prompt_tag}]` (`:1530`). Events inside a batch are delimited `--- Event {i} ({prompt_tag}) ---`.

**Cross-field startup invariants** worth noting: `idle_timeout_secs` must be strictly less than `max_turn_duration_secs` or the process refuses to boot (`config.rs:962-969`); any cancel-style handling requires `--dedup=queue` (`validate_multiple_event_handling`, `config.rs:650-669`) — so flipping only `--dedup=drop` fails startup.

`DedupMode` (`config.rs:57-61`): `Drop | Queue`, default `queue`. `Drop` discards new events for a channel while it is in flight.

---

## 6. VERBOSITY — what reaches the channel

**Tool calls and reasoning are never posted to the channel.** `handle_session_update` (`acp.rs:1535-1629`) — every ACP notification arm only writes to `tracing`:

```rust
"agent_message_chunk" => { ... tracing::info!(target: "acp::stream", "{text}"); false }
"tool_call" => { ... tracing::info!(target: "acp::tool", "tool_call: {title} ({kind})"); true }
"tool_call_update" => { ... tracing::info!(target: "acp::tool", "tool_call_update: {tool_id} → {status}"); false }
"plan" => { tracing::info!(target: "acp::plan", "plan update received"); false }
"agent_thought_chunk" => { ... tracing::debug!(target: "acp::thought", "{text}"); false }
```

`pool.rs`/`lib.rs` contain zero references to `session_update` / `agent_message_chunk` / `tool_call`. Confirmed: no code path turns a tool call or thought into a chat message. The agent's only channel voice is its own deliberate `buzz messages send`.

**Status is expressed through three ambient channels instead:**

1. **Reactions as a two-phase status light.** `pool.rs:3141-3153`:

   > "Two-phase lifecycle visible to users: 👀 'seen' — event was queued and an agent will handle it; 💬 'working' — agent is actively prompting"

   `pool.rs:3492-3493`: `const REACTION_SEEN: &str = "👀"; const REACTION_WORKING: &str = "💬";`
   👀 added at queue-push (`lib.rs:2205-2216`), 💬 added before prompting (`pool.rs:3686`), both removed on any exit path by a drop guard. `ReactionGuard` doc (`pool.rs:3155-3169`):

   > "Drop guard that spawns reaction cleanup on any exit path. Created at the top of `run_prompt_task`. On drop — normal return, early return, or panic — spawns fire-and-forget removal of both 👀 and 💬. ... Failures are debug-logged and ignored — reactions are cosmetic."

   **No success or error reaction exists.** Completion is signalled by the _absence_ of 💬.

2. **Typing indicators.** Kind `20002` (`buzz-core/src/kind.rs:407`), empty content, thread-tagged, republished **every 3 seconds** while a turn runs (`lib.rs:1594-1599`), cleared on result (`lib.rs:2355-2357`). Published fire-and-forget with `try_send` so a full channel drops it rather than blocking (`relay.rs:830-834`).

3. **Owner-only encrypted observer frames** — opt-in deep telemetry. `--relay-observer` / `BUZZ_ACP_RELAY_OBSERVER`, **default false** (`config.rs:473-475`). Kind `KIND_AGENT_OBSERVER_FRAME = 24200` (`buzz-core/src/kind.rs:409`), ephemeral (never stored), NIP-44 encrypted to the owner's pubkey (`lib.rs:803`), and in `P_GATED_KINDS` so the relay closes any REQ whose `#p` isn't exactly the authenticated reader (`kind.rs:135-138`). Raw ACP JSON-RPC (`acp.rs:971,1128,1422`) — every tool call and thought — flows here. `crates/buzz-sdk/src/builders.rs:240-244`:

   > "Observer frames are transient, owner-scoped agent telemetry/control messages. They use a Buzz ephemeral event kind and carry NIP-44 encrypted JSON in the event content so relays can route frames without reading ACP internals."

   **This is the cleverest thing in the repo: full agent observability that is cryptographically scoped to the owner and invisible to the channel.**

**No ephemeral / placeholder-then-edit pattern.** `build_edit` (kind 40003) exists in the SDK (`builders.rs:377-389`) but has zero callers in `buzz-acp`. Searches for `placeholder`, `"working..."`, `progress message` in the crate: no matches. Not implemented.

**Errors DO surface as visible chat messages — but only after retries are exhausted.** `post_failure_notice` (`pool.rs:3550-3559`) posts a plain kind:9 into the triggering thread:

> "Best-effort: post a visible failure notice (kind:9) to a channel after a batch is dead-lettered. ... Errors are logged and swallowed — the notice must never take down the main loop."

Content strings (`lib.rs:3104-3159`):

- `"⚠️ I couldn't process the last request (the turn exceeded the maximum duration ({}s)). Please re-send if it's still needed."`
- `"⚠️ I couldn't process the last request after multiple retries (the turn exceeded the maximum duration ({}s)). Please re-send if it's still needed."`
- ``"⚠️ I couldn't process the last request: authentication failed. Please re-authenticate the CLI (e.g. run `claude /login` or `codex login`) and then re-send."``
- `"⚠️ I couldn't process the last request after multiple retries ({reason}). Please re-send if it's still needed."` where reason ∈ `"the turn timed out"` | `"the agent process exited"` | the error text.

### 6.1 Threading policy — flatten for humans, nest for agents

`turn_is_human_facing` (`queue.rs:1174-1199`):

```
/// Decide whether a turn is human-facing for reply-anchor purposes. A turn is
/// human-facing when the triggering sender is a human, OR a human (other than
/// this agent) is tagged in the triggering event. ... When a participant cannot
/// be classified (no profile fetched), it is treated as human — humans must not
/// lose thread visibility to a misclassification.
```

`resolve_reply_anchor` (`queue.rs:1201-1224`):

```
/// Returns `Some(id)` only for human-facing turns: in a thread → the thread
/// ROOT, keeping the reply flat at layer 1; top-level → the triggering event id,
/// which becomes the new thread root. Returns `None` for agent↔agent turns,
/// leaving the agent free to nest deeply (intentional for agent coordination).
```

Matching prompt text (`base_prompt.md:54-56`):

> For human-facing work, keep the conversation flat and easy to read. ... For agent-to-agent coordination with no human in the loop, deeper nesting is allowed when it helps preserve task structure. Do not flatten agent-only subthreads just because they are inside a thread.

**Excellent idea to steal:** _the presence of a human in the turn changes the display topology._ Human-visible replies stay at depth 1; agent-only coordination is pushed into deep nesting where humans won't see it. Machine chatter is structurally quarantined from human attention without being hidden.

---

## 7. IDENTITY, PERMISSIONS, CROSS-MEMBER INTERACTION

- **Identity:** every agent is a first-class Nostr keypair with its own kind:0 profile and channel memberships — not a shared "bot user". The Bot role exists in the five-role vocabulary (covered in our existing spike).
- **Owner binding:** NIP-OA `["auth", owner_pk, conditions, sig]` tag in the agent's kind:0 profile. Resolved at startup from `BUZZ_AUTH_TAG`, falling back to `--agent-owner` (`lib.rs:1367-1373`). If `respond_to=owner-only` and no owner resolves, the harness warns that **all events will be dropped** (`lib.rs:1378-1381`).
- **Someone other than the owner talks to the agent:** governed entirely by `respond_to`. Default `owner-only` — a non-owner human in a shared channel gets **silence, with no explanation posted**. `allowlist` adds explicit pubkeys; `anyone` opens it up. Siblings (same-owner agents) are always admitted in owner-only and allowlist.
- **DM hardening (steal this):** in a DM, `allowlist` and `anyone` are _ignored_ — only owner and verified siblings can fire a turn (`lib.rs:224-234`, quoted in §1.1). The reasoning is that clients auto-`p`-tag every DM participant, so in a DM every message looks like a mention; combined with agent-initiated DMs to third parties, `anyone` would become a transitive access grant. Channel-type resolution is fail-closed to DM.
- **Deployment-level ceiling:** `--allowed-respond-to` / `BUZZ_ACP_ALLOWED_RESPOND_TO` lets an operator restrict which `respond_to` modes are permissible; the harness refuses to start otherwise (`config.rs:989-1010`). E.g. a hosted deployment can forbid `anyone` entirely.
- **`--permission-mode` defaults to `bypass-permissions`** (`config.rs:432-441`) — per-tool-call approval is skipped by default. Worth flagging as a default we would not copy.

---

## 8. CONFIG SURFACE (buzz-acp — the behavior-relevant subset)

All per-agent-process (global) unless noted. Flags are kebab-case of the field; every one has an env var.

| Flag                                       | Env                                             | Default                  | Governs                                                       |
| ------------------------------------------ | ----------------------------------------------- | ------------------------ | ------------------------------------------------------------- |
| `--respond-to`                             | `BUZZ_ACP_RESPOND_TO`                           | `owner-only`             | Author gate: `owner-only` / `allowlist` / `anyone` / `nobody` |
| `--respond-to-allowlist`                   | `BUZZ_ACP_RESPOND_TO_ALLOWLIST`                 | —                        | Comma-sep 64-char hex pubkeys; owner always implicit          |
| `--allowed-respond-to`                     | `BUZZ_ACP_ALLOWED_RESPOND_TO`                   | empty (all)              | Deployment ceiling on the above                               |
| `--agent-owner`                            | `BUZZ_ACP_AGENT_OWNER`                          | —                        | Owner pubkey (fallback to `BUZZ_AUTH_TAG`)                    |
| `--subscribe`                              | `BUZZ_ACP_SUBSCRIBE`                            | `mentions`               | `mentions` / `all` / `config`                                 |
| `--no-mention-filter`                      | `BUZZ_ACP_NO_MENTION_FILTER`                    | false                    | Drop the `#p` requirement in mentions mode                    |
| `--kinds`                                  | `BUZZ_ACP_KINDS`                                | msg/approval/reminder    | Nostr kinds to wake on                                        |
| `--channels`                               | `BUZZ_ACP_CHANNELS`                             | all discovered           | Coarse channel allowlist (ignored in config mode)             |
| `--config`                                 | `BUZZ_ACP_CONFIG`                               | `./buzz-acp.toml`        | Rules file — the ONLY per-channel surface                     |
| `--multiple-event-handling`                | `BUZZ_ACP_MULTIPLE_EVENT_HANDLING`              | `steer`                  | Mid-turn arrival policy                                       |
| `--dedup`                                  | `BUZZ_ACP_DEDUP`                                | `queue`                  | `drop` / `queue` while in flight                              |
| `--no-ignore-self`                         | `BUZZ_ACP_NO_IGNORE_SELF`                       | false (ignore_self=true) | Self-event suppression                                        |
| `--context-message-limit`                  | `BUZZ_ACP_CONTEXT_MESSAGE_LIMIT`                | `12` (0..=100)           | Pre-fetched history window                                    |
| `--max-turns-per-session`                  | `BUZZ_ACP_MAX_TURNS_PER_SESSION`                | `0` (disabled)           | Proactive session rotation                                    |
| `--agents`                                 | `BUZZ_ACP_AGENTS`                               | `1` (1..=32)             | Parallel subprocesses in the pool                             |
| `--idle-timeout`                           | `BUZZ_ACP_IDLE_TIMEOUT`                         | `900`                    | Silence before killing a turn                                 |
| `--max-turn-duration`                      | `BUZZ_ACP_MAX_TURN_DURATION`                    | `7200`                   | Wall-clock cap (ceiling 604800)                               |
| `--heartbeat-interval`                     | `BUZZ_ACP_HEARTBEAT_INTERVAL`                   | `0` (off)                | Self-prompting cadence                                        |
| `--turn-liveness-secs`                     | `BUZZ_ACP_TURN_LIVENESS_SECS`                   | `10`                     | Crash-backstop ping                                           |
| `--system-prompt` / `--system-prompt-file` | `BUZZ_ACP_SYSTEM_PROMPT[_FILE]`                 | —                        | Persona                                                       |
| `--team-instructions`                      | `BUZZ_ACP_TEAM_INSTRUCTIONS`                    | —                        | Layer between `[System]` and memory                           |
| `--base-prompt-file` / `--no-base-prompt`  | `BUZZ_ACP_BASE_PROMPT_FILE` / `_NO_BASE_PROMPT` | compiled-in              | Replace/drop the platform prompt                              |
| `--memory` / `--no-memory`                 | `BUZZ_ACP_MEMORY` / `_NO_MEMORY`                | on                       | NIP-AE core memory injection                                  |
| `--no-presence`                            | `BUZZ_ACP_NO_PRESENCE`                          | false                    | online/offline status                                         |
| `--no-typing`                              | `BUZZ_ACP_NO_TYPING`                            | false                    | Typing indicators                                             |
| `--relay-observer`                         | `BUZZ_ACP_RELAY_OBSERVER`                       | false                    | Encrypted owner-only telemetry                                |
| `--permission-mode`                        | `BUZZ_ACP_PERMISSION_MODE`                      | `bypass-permissions`     | Tool approval flow                                            |
| `--model`                                  | `BUZZ_ACP_MODEL`                                | —                        | Model id applied per session                                  |
| `--lazy-pool`                              | `BUZZ_ACP_LAZY_POOL`                            | false                    | Subscribe before spawning subprocesses                        |

Undocumented escape hatch: `BUZZ_ACP_EVENT_BUFFER` is read by raw `std::env::var` in `relay.rs:36` with **no CLI flag**, contradicting the README's claim that every env var has one.

Doc/code drift on the idle timeout: code says `900` (`config.rs:27`), README says `620` (`README.md:114`), `.env.example` says `320`. Three numbers for one knob.

---

## 9. MEMORY AND HISTORY RECALL

**No RAG, no automatic summarization of channel history, no retrieval tool over the transcript. The agent shells out to the CLI on demand.**

`base_prompt.md:77-82` is the whole strategy:

> ## Startup Recovery
>
> 1. `buzz feed get` — surface pending mentions and action items. Filter by type: `mentions`, `needs_action`, `activity`, `agent_activity`.
> 2. `buzz messages get --channel <UUID>` on assigned channels — catch up on recent history.
> 3. Check `AGENTS.md` in your working directory for team context.
> 4. Check `RESEARCH/`, `GUIDES/`, `PLANS/` before searching externally. Use `buzz messages search --query "..."` for cross-channel keyword lookups.

- `buzz messages search` is real full-text search: Postgres `generated tsvector` + GIN + `websearch_to_tsquery`/`ts_rank_cd` (`crates/buzz-search/src/lib.rs:3-6`, `query.rs:142-146,236`), params `--query --author --since --limit` (`crates/buzz-cli/src/lib.rs:472-489`). **CLI only — it is not an MCP tool.** Agents reach it by running a shell command.
- **Default MCP tool count is zero.** `mcp_command` defaults to `""` (`config.rs:261-262`) and `build_mcp_servers()` returns `vec![]` when empty (`lib.rs:4142-4145`). If the operator points `BUZZ_ACP_MCP_COMMAND` at `buzz-dev-mcp`, the agent gains `shell`, `read_file`, `view_image`, `str_replace`, `todo`, `_Stop`, `_PostCompact` (`crates/buzz-dev-mcp/src/lib.rs`). **The agent's entire Buzz interface is the `buzz` CLI invoked through a `shell` tool** — no purpose-built chat API surface.
- **Durable memory is the agent's own filesystem plus NIP-AE engrams.** `core` (one per agent/owner pair, auto-injected each session) vs `mem/<slug>` cold entries read on demand; kind 30174, NIP-44 symmetric between agent and owner (`docs/nips/NIP-AE.md:9,32-33`), 65,535-byte plaintext cap (`buzz-core/src/engram.rs:28`). Plus a conventional workspace (`base_prompt.md:84-100`): `RESEARCH/`, `PLANS/`, `GUIDES/`, `WORK_LOGS/`, `OUTBOX/`, `REPOS/`, `.scratch/`.
- `crates/buzz-agent/src/handoff.rs` is **self**-compaction, not agent-to-agent handoff: when input tokens cross ~90% of `max_context_tokens` (default 200_000), the agent summarizes its own history into `[Context Handoff]\n{summary}` and continues, capped by `max_handoffs` (default 10). Summarizer system prompt (`handoff.rs:25-28`):
  > "You are generating a context handoff summary for the next turn of an autonomous agent. Be concise but thorough. Cover: what the original task was, what you accomplished, key decisions made, what remains, and one concrete next step. Output plain text only — no tool calls, no JSON. Stay under 8192 tokens."

---

## 10. TECH STACK AND PLATFORM TARGETS

- **Relay:** Rust, Axum WebSocket + REST, PostgreSQL (events + FTS), Redis (pub/sub + presence), S3/MinIO (media). 26 crates.
- **Protocol:** Nostr NIP-01, extended with 14 custom NIPs in `docs/nips/` (NIP-AA/AE/AM/AO/AP/CW/DV/ER/GS/IA/OA/PL/RS/WP). Standard kinds 0–9999, Buzz kinds 40000–49999, ephemeral 20000–29999.
- **Clients:** Tauri + React desktop (shipped), Flutter mobile (in development), `web/`, `admin-web/`. **Buzz is its own chat product — it is not a Slack or Discord bot framework.** No Slack/Discord adapter exists anywhere in the repo.
- **Agent bridge:** ACP (Agent Client Protocol) JSON-RPC over stdio — the same protocol Zed uses. Pluggable runtimes: `goose` (default), `claude-agent-acp`, `codex-acp`, `buzz-agent` (their own Anthropic/OpenAI/Databricks loop).
- Apache 2.0, Block Inc.
- Formal methods present: TLA+ specs (`docs/spec/GitOnObjectStore.tla`, `MultiTenantRelay.tla`) and a Tamarin proof (`MultiTenantAuth.spthy`).

---

## 11. WHAT TO STEAL / WHAT TO AVOID

**Steal:**

1. **Two-question separation.** "Do I run a turn?" (cheap, deterministic, no tokens) vs "Do I say anything?" (model judgment). Never pay for an LLM call to decide whether to pay for an LLM call.
2. **Addressing by resolved identity, not by string.** The `p`-tag mechanism means mention matching cannot be spoofed by content and cannot false-positive on a name appearing in prose. The failure mode is honest and loud: partial names simply don't resolve.
3. **`is_agent` as a first-class, cryptographically-derived participant attribute** (NIP-OA owner attestation), and the sibling concept — "another agent owned by the same human" is exactly the right trust primitive for a shared room.
4. **Human-presence-dependent threading.** Flatten when a human is in the turn; allow deep nesting for agent-only coordination. Machine chatter is structurally quarantined from human attention.
5. **Owner-scoped encrypted observability.** Full tool-call/reasoning telemetry on an ephemeral, `#p`-gated, NIP-44-encrypted kind. The channel stays clean; the operator sees everything; nobody else can.
6. **Reactions and typing as the ambient status layer**, with a drop-guard so status can never leak on a panic path. Zero chat pollution for "I'm working on it".
7. **Steer vs Interrupt as distinct, _named to the model_, mid-turn semantics.** The merge framing text tells the model exactly what happened to it — far better than silently truncating or silently queueing.
8. **In-channel owner control verbs** (`!cancel`, `!rotate`) consumed by the harness and never forwarded.
9. **DM hardening.** The transitive-access-grant analysis in `lib.rs:224-234` is a real vulnerability class we will have in DMs, and their fix (allowlist/anyone do not apply inside DMs; fail closed on unknown channel type) is correct.
10. **`--allowed-respond-to`** — a deployment-level ceiling on per-agent policy. Two-tier permissioning.
11. **`docs/welcome-kickoff-silent-failures.md` as a genre.** An honest, cited, still-has-open-items postmortem checked into the repo.

**Avoid / do better:**

1. **No cross-agent arbitration.** Mention-addressing is the only thing standing between a 3-agent channel and 3 simultaneous answers. We should have an actual arbitration story.
2. **No hard loop breaker.** Buzz says so itself: no depth counter, no hop limit, no cooldown, no agent-to-agent budget. Their own proposed design (consecutive agent-authored turns in a thread, reset by a human message, N≈6–10, log when it fires) is a good starting point — build it, don't just prompt it. Their caveat is real: too tight and you manufacture unexplained silence.
3. **`is_agent` is computed and then withheld from the model.** Tell the agent which participants are bots. It cannot apply "don't ping-pong with other agents" judgment on information it doesn't have.
4. **No roster in context.** The agent doesn't know who is in the room. We have a per-channel roster with roles — inject it.
5. **No history for plain top-level channel messages.** Zero context unless it's a thread reply or DM. Combined with `since=now` on subscribe, a Buzz agent is remarkably amnesiac about the room it lives in.
6. **`respond_to` is per-agent-global, not per-channel** — and the desktop UI misleadingly implies otherwise from the channel members sidebar. Per-channel policy is exactly what a multi-room product needs.
7. **Fail-closed filters that silently mute.** A filter expression that times out 5 times disables a rule for the process lifetime with only a log line. Silent muting of an agent is the worst failure mode in a chat product.
8. **`bypass-permissions` as the default** tool-approval mode.
9. **Config drift** — three different documented values for the idle timeout, a README-documented TOML shape the loader cannot parse, and an env var with no flag. Their config surface has outgrown its documentation.
10. **CLI-as-API.** The agent's only interface to Buzz is shelling out to `buzz`. It works, and it makes the base prompt double as API documentation (see the command table at `base_prompt.md:7-23`), but it means no structured tool schemas, no argument validation before execution, and prompt text like "Partial names fail silently" doing the job a typed API should do.

---

## Appendix — key files

| Path                                              | Purpose                                                   |
| ------------------------------------------------- | --------------------------------------------------------- |
| `crates/buzz-acp/src/lib.rs` (6639 L)             | Main event loop, author gate, control commands, mode gate |
| `crates/buzz-acp/src/base_prompt.md` (136 L)      | The platform prompt every agent gets                      |
| `crates/buzz-acp/src/filter.rs` (787 L)           | Subscription rule matching, mention check, evalexpr       |
| `crates/buzz-acp/src/queue.rs` (4759 L)           | Per-channel queue, batching, prompt rendering, threading  |
| `crates/buzz-acp/src/pool.rs` (5821 L)            | Subprocess pool, session/new, reactions, context fetch    |
| `crates/buzz-acp/src/relay.rs` (6233 L)           | Nostr WS client, REQ construction, typing events          |
| `crates/buzz-acp/src/config.rs` (2844 L)          | Full config surface                                       |
| `crates/buzz-acp/src/observer.rs` (166 L)         | In-process ACP telemetry bus                              |
| `crates/buzz-acp/src/engram_fetch.rs` (248 L)     | NIP-AE core memory injection                              |
| `docs/welcome-kickoff-silent-failures.md` (502 L) | **The loop postmortem — highest-value doc**               |
| `desktop/src-tauri/src/managed_agents/runtime.rs` | Desktop agent supervisor / env construction               |
| `docs/nips/NIP-OA.md`, `NIP-AE.md`                | Owner attestation, agent engram memory                    |
