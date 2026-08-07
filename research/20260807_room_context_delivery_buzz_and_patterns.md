---
title: 'How agents receive room context — Buzz (block/buzz) prior art and external patterns'
date: 2026-08-07
type: external-best-practices
status: active
tags: [rooms, agent-context, buzz, nostr, chat-compaction, multi-agent, mesh, relay, addressing]
---

# How agents receive room context — Buzz prior art and external patterns

## Headline finding

Buzz does **not** run a pure push model or a pure pull model — it runs the same
hybrid DorkOS has already spec'd in `specs/room-participation/02-specification.md`
(RP3 ambient push off a cursor + RP7 pull tools for the full backlog), independently
arrived at from a completely different substrate (Nostr relay + ACP harness, Rust,
vs. DorkOS's SQLite room log + TypeScript). That convergence is the strongest
validation signal in this report. The one place the two designs diverge is exactly
the place the task frames as "our decided direction": Buzz never treats the
triggering message as something the agent must pull — the event(s) that woke the
agent are **always pushed** into the prompt verbatim; only supplementary context
(thread/DM backscroll beyond that) and full backlog are pull-only. A design that
makes even the triggering message pull-only has no real-world precedent in the
system studied here, Buzz included.

Repo studied: `github.com/block/buzz` (refreshed via `opensrc fetch` immediately
before this research; cached at
`/Users/doriancollier/.opensrc/repos/github.com/block/buzz/main`). All paths below
are relative to that root unless marked `dorkos:`.

---

## Part 1 — Buzz source review

### 1.0 Orientation: which crate does what

Buzz is a Nostr relay (`crates/buzz-relay`) plus an ACP-based agent harness
(`crates/buzz-acp`) that bridges Nostr room events to any [Agent Client
Protocol](https://agentclientprotocol.com/) agent (Claude Code, Goose, etc. — Buzz
itself ships a reference ACP agent in `crates/buzz-agent`) over stdio. Messages,
threads, reactions, and channels are Nostr events with Buzz-specific kind numbers
(`crates/buzz-core/src/kind.rs`, ~140 constants, e.g. `KIND_STREAM_MESSAGE = 9`,
`KIND_STREAM_MESSAGE_V2 = 40002`). The pieces that matter for this research:

- `crates/buzz-acp/` — the harness. Subscribes to the relay, decides which events
  wake an agent, builds the ACP prompt, drives the agent subprocess, executes its
  tool calls. This is the closest analog to DorkOS's `apps/server/src/services/rooms`
  - `room-turn-runner.ts`.
- `crates/buzz-agent/` — a reference ACP agent implementation (the LLM turn loop,
  tool execution, its own context/handoff compaction). Analog to a DorkOS runtime
  adapter (`apps/server/src/services/runtimes/claude-code/`).
- `crates/buzz-cli/` — the `buzz` CLI, which is how agents actually touch the room
  (send, get, thread, search, react — see §1.4). Not an MCP tool with a JSON
  schema; a subprocess CLI invoked through a generic shell tool.
- `crates/buzz-dev-mcp/` — the MCP server that gives the agent `shell`, `read_file`,
  `str_replace`, etc. `buzz` rides on PATH inside `shell`.
- `docs/nips/` — Buzz's own NIP-style protocol specs (NIP-RS, NIP-CW, NIP-AE, …),
  written with the same rigor as an RFC. Several are directly on-topic (§1.2, §1.6).

### 1.1 Push or pull? — Both, split by what triggered the turn

**The triggering event(s) are always pushed**, inline in the prompt text, never
behind a tool call. `crates/buzz-acp/src/queue.rs:1076-1141` (`format_event_block`)
renders each new event as an `[Event]` block — event id, channel, kind, sender,
timestamp, full content, tags, parsed thread/mention structure — and
`format_prompt` (`queue.rs:1406+`) assembles one prompt per **batch**: all events
that arrived for a channel while no turn was in flight for it get drained into a
single prompt (`crates/buzz-acp/src/queue.rs:1-14` module doc; dedup mode is
`Drop` by default — new events during an in-flight turn are silently dropped, or
`Queue`/`Steer`/`Interrupt` depending on `--multiple-event-handling`).

**Everything beyond the trigger is pull, gated by a small, count-capped, auto-fetched
exception.** Before prompting, the harness optionally fetches a bounded
"conversation context" — thread replies or DM backscroll — and pushes _that_ too
(`crates/buzz-acp/src/pool.rs:2497-2523`, `fetch_conversation_context`):
thread-reply events get thread context (root + replies via `#e`/`#h` Nostr filter,
`pool.rs:2676-2738`), DM non-replies get recent DM history
(`pool.rs:2741-2783`). Plain top-level channel messages get **no** auto-context at
all — the prompt's `[Context]` block just says "Hint: Use `buzz messages get
--channel <UUID>` for recent messages if needed" (`queue.rs:1303-1312`).

The cap is `--context-message-limit`, env `BUZZ_ACP_CONTEXT_MESSAGE_LIMIT`, default
**12**, hard max **100**, `0` disables it entirely
(`crates/buzz-acp/src/config.rs:364-368`). It is a pure count cap — no
content-length-based clamp. When the real total exceeds the cap, Buzz doesn't
summarize the dropped tail; it sets a boolean and tells the agent to go pull it:

```
[Thread Context (12 of 47 messages, truncated)]
...
Thread context included below. Use `buzz messages thread --channel <UUID> --event <ID>` for full history if truncated.
```

(`queue.rs:1233-1349`, `format_context_hints` / `format_conversation_context`).
**Buzz has no LLM-summarization step for room/channel history, anywhere.**
Summarization does exist in the codebase, but it's reserved for a completely
different problem — see §1.3.

### 1.2 Per-agent "what have I seen" — no durable server-side cursor for agents

This was the most surprising finding. Unlike a human client (see NIP-RS below),
**the ACP harness's notion of "what I've already processed" is an in-memory,
per-process, best-effort watermark, not a persisted cursor**:

- `BgState` (`crates/buzz-acp/src/relay.rs:975-1020`) holds `last_seen:
HashMap<Uuid, u64>` (newest `created_at` seen per channel), `channel_dropped_since`
  (oldest timestamp lost to backpressure, for gap replay), `subscribe_since`, and a
  `TwoGenDedup` set of event ids (bounded two-generation dedup, not an unbounded
  seen-set).
- On a **fresh subscribe** the `since` filter is `now()` — a newly started harness
  does **not** replay history; it only sees events from the moment it connects
  (`relay.rs:3151-3194`, `send_subscribe`: "on first subscribe use current time to
  avoid replaying history").
- On **reconnect** (WebSocket drop within a live process), `since = min(last_seen,
channel_dropped_since) - SINCE_SKEW_SECS` — a skew buffer that deliberately
  re-requests a little overlap rather than risk a gap (`relay.rs:2469`, tested at
  `relay.rs:4799-4820`).
- None of this is written to disk. There is no state file, no sqlite row, no
  `last_seen.json` (verified by search — zero hits for any persistence path in
  `crates/buzz-acp/src`). A **process restart**, not just a reconnect, permanently
  loses anything sent while the harness was down; `since=now()` on fresh subscribe
  means it is gone, not replayed.

This is worth flagging as a real gap, not just a design choice: the crate's own
README claims "On startup, the harness replays all unprocessed @mentions since the
last run" (`crates/buzz-acp/README.md`, "How It Works" step 6), which the code
does not actually do for a cold process restart — only for a live reconnect within
one running process. Doc/behavior mismatch; see §1.6.

The one durable, cross-device cursor Buzz does define is **NIP-RS** (Cross-Device
Read State Sync, `docs/nips/NIP-RS.md`) — but it is explicitly a **human**
mechanism: a `kind:30078` per-client blob, NIP-44 encrypted to the user's own
keypair, storing `{context_id: last_read_timestamp}` merged across devices as a
grow-only max-register CRDT, fetched with a 7-day horizon. It is never read by the
agent harness. Agents get no equivalent — their "unread" state is whatever their
one live process happens to remember.

### 1.3 Long rooms: two _different_ compaction mechanisms for two different problems

**Room/channel history** (what the agent sees of the conversation): count-capped
truncation only (§1.1) — 12 messages by default, a `truncated: true` flag, and a
pull instruction. No summarization of the dropped tail.

**The agent's own turn/tool-call history** (what it remembers of its own work
across many rounds of the _same_ task) is a completely separate mechanism,
`crates/buzz-agent/src/handoff.rs`. When token/byte pressure crosses a threshold
(`RunCtx::should_handoff`, gated on real provider-reported token usage with a byte
heuristic fallback — see `agent.rs:145-177`), `maybe_handoff` calls the LLM itself
to produce a structured summary ("what was the task, what was accomplished, key
decisions, what remains, one concrete next step" — the system prompt is inlined at
`handoff.rs:25-28`), clears the whole history vector, fires a `_PostCompact` hook
so extensions can re-inject durable state into the fresh context, and continues
with `[Context Handoff]\n<summary>` as the sole seed message
(`handoff.rs:30-95`). A hard `max_handoffs` cap falls back to blunt truncation
(`agent.rs:711-738`, `truncate_history` — drops oldest complete `User..ToolResult`
groups until under a byte budget) if handoffs are exhausted.

The split is deliberate and instructive: **LLM summarization is reserved for an
agent's own accumulated reasoning/tool-call trail, where losing the narrative
thread is expensive; room history — someone else's words — gets simple
count-based truncation plus a cheap re-fetch, because the source of truth (the
relay) still has it and re-reading beats summarizing something you didn't say.**

Orthogonal to both: `KIND_AGENT_ENGRAM` / NIP-AE (`kind.rs:89-94`, not read in
depth here) gives an agent NIP-44-encrypted, addressable long-term memory that
survives handoffs and restarts — a third mechanism for a third problem (durable
knowledge, not conversation replay).

### 1.4 Room interaction — one CLI behind a generic shell tool, not per-action MCP schemas

The agent does **not** get a JSON-schema'd `read_room`/`post_message`/`react` tool
set. It gets one MCP tool, `shell` (`crates/buzz-dev-mcp/src/lib.rs`, tool
description: _"...On PATH: rg ..., tree ..., and buzz (Buzz relay CLI — run `buzz
--help` for commands)."_), and the `buzz` CLI binary is on PATH. Every room
interaction is a subprocess call the agent composes itself. The relevant
subcommands (clap-derived, full flag docs at `crates/buzz-cli/src/lib.rs:347-499`,
`698-726`, `923-936`):

| Command                                             | Flags                                                                                           | What it does                                                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buzz messages get`                                 | `--channel <UUID>` `--limit` (≤200, default 50) `--before <ts>` `--since <ts>` `--kinds 1,1984` | **The delta-read tool.** `since`/`before` are plain Unix timestamps the agent supplies itself — no server-tracked cursor (`commands/messages.rs:263-302`) |
| `buzz messages thread`                              | `--channel <UUID>` `--event <ID>` `--limit` (≤500, default 100) `--depth-limit`                 | Full reply chain for a root event (`commands/messages.rs:304-338`)                                                                                        |
| `buzz messages search`                              | `--query` `--author` `--since` `--limit`                                                        | Full-text search across messages                                                                                                                          |
| `buzz messages send`                                | `--channel` `--content` (`-` for stdin) `--kind` `--reply-to` `--broadcast` `--file`            | Post; `--reply-to` threads it                                                                                                                             |
| `buzz messages send-diff`, `edit`, `delete`, `vote` | —                                                                                               | Diff/patch posts, edits, deletes, forum votes                                                                                                             |
| `buzz reactions add / remove / get`                 | `--event` `--emoji` `--emoji-url`                                                               | React                                                                                                                                                     |
| `buzz feed get`                                     | `--since <ts>` `--limit` `--types mentions,needs_action,activity,agent_activity`                | **A second, cross-channel delta tool** — everything relevant to this agent since a timestamp, typed                                                       |
| `buzz channels list / get / search`                 | —                                                                                               | Discover rooms                                                                                                                                            |

`buzz messages get --since <ts>` and `buzz feed get --since <ts>` are the direct
analogs of "a tool to read the delta of room messages it hasn't seen yet" — except
the timestamp is caller-supplied on every call, not server-remembered. The agent
(or its harness/system-prompt convention) is responsible for tracking and passing
its own watermark if it wants true delta semantics from the CLI itself; nothing
below the CLI enforces or persists one.

### 1.5 Who responds — layered gates, not a single rule

Three independent gates, in order:

1. **Author eligibility** (`--respond-to`: `owner` (default) / `allowlist` +
   `--respond-to-allowlist` / `anyone` / `nobody`; owner is always included
   automatically — `crates/buzz-acp/README.md` "Response Policy" section). This is
   "who is allowed to trigger me at all," independent of mentions.
2. **Subscription match** (`crates/buzz-acp/src/filter.rs`) — an ordered,
   first-match-wins list of `SubscriptionRule`s, each with a `ChannelScope`
   (`all` or an explicit channel-id list), an optional `kinds` allowlist (empty =
   wildcard), a `require_mention: bool` (must carry a `p`-tag naming the agent —
   `filter.rs:387-399`), and an **optional evalexpr boolean expression**
   evaluated against `{content, author, kind, channel_id, timestamp}`
   (`filter.rs:26-51`) with a hard timeout and a fail-closed circuit breaker after
   `MAX_CONSECUTIVE_TIMEOUTS` (rule disables itself rather than risk blocking the
   dispatch loop). Default posture is `subscribe=mentions` (`require_mention:
true`), so an agent is invisible to ordinary channel chatter unless a rule
   opts it in — explicitly documented as the reason forum posts (which don't
   `@mention`) need `--no-mention-filter` (README, "Forum Channels").
3. **`event_mentions_agent`** (`crates/buzz-acp/src/lib.rs:2711-2716`) — the raw
   `p`-tag-equals-my-pubkey check used for the harness's own control-command
   gating (e.g. the owner-only `!shutdown` convention, `kind.rs:340-342`) and for
   in-flight-turn steering decisions (`mode_gate_signal`, `lib.rs:2741-2755`:
   `Queue` / `Steer` / `Interrupt` / `OwnerInterrupt`, i.e. what a _new_ event does
   to a turn already running for that channel).

`@Name` mentions in ordinary chat text are resolved to Nostr `p`-tags at
**compose time**, client-side or by the workflow engine
(`crates/buzz-relay/src/workflow_sink.rs:22-121`, `resolve_mention_pubkeys`,
extensively unit-tested for Unicode edge cases — combining marks, `İ`-casing,
back-to-back `@a@b`, etc.) — the wake gate itself only ever looks at structured
`p` tags, never re-parses `@name` out of prose. Reply/thread anchoring separately
asks "is this turn human-facing?" (`turn_is_human_facing`, `queue.rs:1182-1199`):
an agent-authored trigger with only agent mentions is agent↔agent and gets no
forced reply-anchor (free to nest threads deeply); anything touching a human gets
flattened to the thread root so people don't lose the plot.

**Concurrency, not identity, is the unit of exclusivity.** N agent _processes_
authenticate as the **same** Nostr bot identity (`README.md`, "Shared Identity")
— users see one bot regardless of N. The per-channel event queue guarantees a
channel is never processed by two of those processes at once; cross-channel
ordering across processes is explicitly not guaranteed. This sidesteps "which
agent instance responds" by making instances interchangeable workers behind one
identity + a work queue, rather than routing by identity at all.

### 1.6 Clever things worth stealing, and cautions worth avoiding

**Steal:**

- **A typed, cross-channel delta feed as a first-class tool** (`buzz feed get
--since --types mentions,needs_action,activity,agent_activity`), separate from
  per-channel `messages get`. It's what the idle-time **heartbeat** calls by
  default (`--heartbeat-prompt` default: _"Check get_feed_actions() for pending
  approvals, then get_feed_mentions() for unanswered mentions..."_,
  `crates/buzz-acp/src/lib.rs:3609-3634`) — a deliberate pull-based safety net
  against anything the push path dropped or missed, decoupled from any one
  channel's queue. Lower priority than live events, skipped when all agents are
  busy, at most one in flight globally.
- **Splitting compaction by ownership of the content** (§1.3): summarize _your
  own_ accumulated reasoning when it's expensive to lose; never summarize _other
  people's_ words in the room — truncate with a re-fetch instruction instead, and
  let the tool/search index be the actual answer for "what did I miss."
- **A skew buffer on reconnect `since`** (`SINCE_SKEW_SECS`) rather than an exact
  boundary — cheap insurance against off-by-one gaps at the cost of a little
  duplicate delivery, paired with a bounded two-generation dedup set so the
  duplicates don't reach the agent.
- **Fail-closed, self-disabling filter rules** under evaluation timeout
  (`MAX_CONSECUTIVE_TIMEOUTS`) — a misbehaving custom filter degrades to "this
  rule stops matching," not "the dispatch loop hangs."
- **Modeling hook/objection output as tool results, not as user messages**
  (`crates/buzz-agent/src/agent.rs:634-692`) — a `_Stop` hook's text can't
  impersonate the user because it's structurally a lower-trust tool result, JSON
  escaped so it can't break out with a fake closing delimiter.

**Avoid / caution:**

- **No durable per-agent read cursor, and a README that claims one exists.** A
  cold process restart silently drops anything sent while the harness was down;
  the "since=now on fresh subscribe" behavior contradicts the doc's "replays all
  unprocessed @mentions since the last run" claim (§1.2). If DorkOS ships a
  cursor, it should be genuinely durable and read the same way regardless of
  which process last held it — which is already true of `dorkos:
room_members.lastReadSeq` (see Part 3) and is strictly better than what Buzz
  actually does here.
- **Delta semantics live entirely in caller-supplied timestamps**, not a
  server-remembered position (`buzz messages get --since <ts>`). That pushes
  correctness onto the agent/harness remembering to pass the right value every
  time; nothing stops a bug from silently re-reading or silently skipping.
- **Room interaction via a generic shell + CLI, not typed MCP tools with JSON
  schemas.** Flexible and cheap to extend (new subcommand = new capability, no
  tool-list churn), but it means the model has to compose flag strings correctly
  from a `--help` text rather than a validated schema, error messages are
  whatever the CLI prints, and every call pays a subprocess-spawn cost. This
  trades discoverability/validation for generality; worth naming explicitly as a
  choice DorkOS should make consciously rather than default into.
- **Truncation with no summarization is a soft default, not a real answer for
  very active rooms** — 12 messages is a small window, and the `truncated: true` +
  "go pull it" hint only helps if the model reliably notices and acts on it.
  Nothing in the observed code measures whether models actually do that.

---

## Part 2 — External patterns (brief)

**Matrix (m.read / m.fully_read).** Two related but distinct primitives:
`POST /rooms/{id}/receipt/{type}/{eventId}` publishes a receipt (a specific event
marked read, federated by default, or `m.read.private` to sync across your own
devices without telling anyone else); `POST /rooms/{id}/read_markers` moves the
`m.fully_read` marker (the "everything up to here" position a client restores on
next open). This is architecturally the closest external analog to Buzz's NIP-RS
and to `dorkos: room_members.lastReadSeq` — a single scalar high-water-mark per
(user, room), separate from any notion of who-mentions-whom. Matrix has no
agent-specific variant; bots read the same event-per-event stream as any client
and track their own position however they like.
[Client-Server API](https://matrix.org/docs/spec/client_server/r0.4.0),
[Matrix read receipts overview](https://patrick.cloke.us/posts/2023/01/05/matrix-read-receipts-and-notifications/).

**AutoGen `GroupChat`.** Pure push, full-fidelity, no compaction at the framework
level: the `GroupChatManager` selects a speaker, collects its response, and
**broadcasts the full message to every other participant** — group chat state
_is_ the shared, complete message history, and every agent's context includes all
of it by construction. Context survives across tasks in the same team unless
explicitly `reset()`. There is no delta/pull primitive because there is no
concept of an agent "catching up" — everyone is always current, which is only
tractable because AutoGen group chats are small, short-lived, and bounded by
design (this doesn't scale to a persistent room with weeks of history the way
Buzz's or DorkOS's does).
[Group Chat — AutoGen](https://microsoft.github.io/autogen/stable//user-guide/core-user-guide/design-patterns/group-chat.html).
LangGraph's supervisor/multi-agent patterns follow the same shape: a shared
state object (often the full message list) threaded through the graph, pruned
manually by whatever node the developer inserts for that purpose — no
platform-level delta or compaction primitive either.

**MCP-based chat tools.** No standardized "room history" capability exists in the
Model Context Protocol itself — MCP defines tools/resources/prompts generically;
any chat-history tool is bespoke per server (exactly Buzz's `buzz` CLI-behind-
`shell` approach, or a purpose-built `get_messages` tool, as DorkOS's own
in-process MCP tools already do for other domains). This is a gap in the
ecosystem, not a pattern to adopt — it means there's no external convention to
converge toward, and DorkOS's own tool schema is the extent of the "standard" it
needs to hit.

**IRC bouncer / ZNC catch-up.** The one genuinely different model: a bouncer
stays connected to the network on the user's behalf and buffers everything;
on reconnect, the client (or agent) replays the buffer from where it left off,
using either a bounded ring buffer (last N lines/bytes, ZNC's classic
`buffer` module) or, in newer bouncers, the IRCv3 `chathistory` extension
(`CHATHISTORY LATEST`/`BEFORE`/`AFTER <target> <bound> <limit>`) — a
server-side, timestamp-or-msgid-cursor pull API purpose-built for exactly "give
me what I missed." This is the closest external precedent to a dedicated
delta-read tool with real server-tracked bounds, and closer to what DorkOS
already specs (`room_members.lastReadSeq` + a capped window) than anything in
AutoGen/LangGraph or Matrix's per-event receipts.

---

## Part 3 — Assessment: does the decided direction hold up?

**Verdict: broadly yes, with one correction.** The three pillars as stated —
(a) a tool to read the delta of unseen room messages, (b) a tool to post, (c)
compaction for long threads with on-demand full-transcript/section access — all
have real precedent in Buzz, and (a)+(c) also match what's already specified in
`dorkos: specs/room-participation/02-specification.md` (RP2/RP3/RP7, `08.1`/`08.3`,
`§10.3`). The correction: **framing it as a pull model undersells what has to be
push.** No system studied here — not Buzz, not AutoGen, not Matrix — makes the
event that woke the agent itself something the agent must fetch. Buzz always
inlines the triggering event(s) verbatim in the prompt (§1.1); AutoGen inlines the
entire history on every turn; Matrix bots subscribe to a live event stream. A
"pure pull, tool-only" room-context design would be a genuine outlier with no
supporting precedent, and it would also contradict `dorkos:
specs/room-participation/02-specification.md:404` ("Pending context is exactly the
room log after this membership's cursor, and the agent's cursor advances when it
takes a turn") — that spec already chose push-the-delta-automatically (RP3,
capped at `ambientMaxEntries: 30`, `pendingTruncated` flag) plus pull-for-more
(RP7's `read_room_history`/`search_room_history`), which is the same shape Buzz
independently converged on. If "pull model" in the task's framing means _the
agent must call a tool to receive its own delta_ rather than _the delta being
handed to it in the prompt automatically_, Buzz's evidence argues against that:
every system here pushes the minimal delta and reserves pull for the deep
backlog.

Where Buzz's evidence sharpens the existing DorkOS design, concretely:

1. **Compaction should stay dumb for room history.** Buzz's split (§1.3) — LLM
   summarization only for the agent's _own_ accumulated reasoning, plain
   count-truncation-plus-refetch for the _room's_ history — is a real, working
   precedent for keeping "long threads get compaction" simple. Neither Buzz nor
   DorkOS's own RP3/RP7 spec do LLM-summarized "older stretches" for room history;
   both stop at a boolean truncation flag plus a pull-the-rest tool. The task's
   framing ("summaries of older stretches") reaches further than either precedent
   validates — that's extra complexity (a new failure mode: a stale or wrong
   summary standing in for what was actually said) buying an outcome neither
   system apparently needed. Treat length-based summarization as an explicit,
   separately-justified addition, not a default component of the design.
2. **DorkOS's cursor is already more durable than Buzz's.** `dorkos:
room_members.lastReadSeq` is a real DB column per (member, room) — Buzz has no
   equivalent for agents (§1.2), only an in-memory per-process watermark that a
   cold restart silently loses, and a README that overclaims durability it
   doesn't have. This is a place DorkOS's existing design is already ahead;
   nothing here argues for weakening it toward Buzz's model.
3. **A typed, cross-room delta/catch-up tool is worth adding explicitly.** Buzz's
   `buzz feed get --since --types mentions,needs_action,activity,agent_activity`,
   driven by the idle heartbeat as a pull-based safety net independent of the
   live event path, has no direct equivalent in the room-participation spec as
   read here (RP7's tools are room-scoped: `read_room_history`,
   `search_room_history`). If DorkOS agents can be members of multiple rooms, a
   cross-room "what needs my attention since T" tool — reusing the same cursor —
   is a cheap, validated addition and a natural pairing with any future
   heartbeat/idle-tick mechanism.
4. **Prefer a typed tool schema over a shell-behind-CLI surface for room
   actions.** Buzz's CLI-via-shell design (§1.4, §1.6) is a real, functioning
   choice, but it's also the one place in this research where a genuine
   external-pattern tradeoff argues _against_ imitation: DorkOS already exposes
   typed MCP tools elsewhere in the codebase, and a validated JSON-schema'd
   `read_room_delta`/`post_to_room`/`search_room_history` set (which is what RP2/
   RP3/RP7 already specify) gives better model reliability and error surfacing
   than composing CLI flags from `--help` text. Nothing in Buzz's design argues
   DorkOS should move toward the CLI shape; if anything, Buzz's own README
   documents the cost (agents need `buzz --help` and to get flag composition
   right) that a typed schema avoids.
5. **Keep authorization (who may trigger a turn at all) and addressing (does
   this turn deserve a reply) as separate gates**, the way Buzz's three-layer
   author-eligibility → subscription-match → mention-check stack does (§1.5).
   DorkOS's `addressing.ts` / `cascade-guard.ts` / `turn-budget.ts` engaged-window
   model (`dorkos: specs/room-participation/02-specification.md` §2.1–2.2) is
   already more conversationally aware than Buzz's static filter-rule engine (it
   implements actual turn-taking theory — SSJ rules — rather than a boolean
   mention gate), so there's nothing to import there; it's a confirmation that
   layering the gates, rather than collapsing them into one mention check, is the
   right shape.

**Net:** the decided direction is sound and independently corroborated by a
production multi-agent chat system built on entirely different infrastructure.
Tighten the framing from "pull model" to "push the triggering delta
automatically, pull everything beyond a small cap," keep compaction dumb
(count/length truncation + a pull tool, no auto-summarization) unless a specific
failure mode justifies more, and treat the already-specified `lastReadSeq` +
`ambientMaxEntries` + `read_room_history`/`search_room_history` shape in
`specs/room-participation/02-specification.md` as validated rather than
superseded by this research.
