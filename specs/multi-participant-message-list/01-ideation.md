# Ideation: Multi-Participant Message List — Slack-style identity, reactions, threads

- **Slug:** multi-participant-message-list
- **Id:** 260725-014841
- **Date:** 2026-07-25
- **Tracker:** TBD (candidate: project "Agents as First-Class Operators")

## Intent

Restructure the chat message list in anticipation of multi-participant conversations — several humans and several agents in one room. Adopt Slack's basic message-list grammar (full-bleed separators, left identity gutter, reactions, threads) without losing any current capability (tool cards, thinking blocks, subagent blocks, approvals, questions, widgets, streaming, virtualization).

The four asks are not equal in cost. Two are presentation. Two are systems:

| Ask                             | Kind         | Real cost                                                       |
| ------------------------------- | ------------ | --------------------------------------------------------------- |
| 1. Full-bleed date/unread rules | presentation | list-row model refactor                                         |
| 2. Avatars + names on the left  | presentation | **author identity on every message** (schema change)            |
| 3. Emoji reactions              | **system**   | DorkOS-owned sidecar store + new SSE events + control semantics |
| 4. Threads                      | **system**   | a second conversation-context model                             |

## What exists today (verified 2026-07-25)

- `MessageList.tsx` virtualizes a flat `ChatMessage[]` (TanStack Virtual, `anchorTo: 'end'`, `followOnAppend`, live measurement with a zero-guard). Dividers today are an absolute `h-px` slot _inside_ a message, not list rows.
- `MessageItem.tsx` branches on `role`: user → right-aligned bubble (`max-w-[var(--msg-user-max-width)]`), assistant → full-width, no bubble. Grouping (`computeGrouping`) keys on **consecutive same role**. Timestamp is hover-revealed, absolutely positioned top-right. There is no avatar and no name anywhere in the message list.
- `ChatMessage.role` is `'user' | 'assistant'` — binary. No author, no sender, no participant.
- **Session storage is runtime-owned** (ADR-0310). There is no DorkOS transcript store: claude-code derives from SDK JSONL, codex from SDK threads, opencode from its sidecar. DorkOS cannot write into a transcript.
- A **durable per-session event log** does exist (`EventLog` / `SessionEventStore`, monotonic `seq`, SSE snapshot → `Last-Event-ID` replay → live). This is DorkOS-owned and is the natural carrier for anything the runtime does not own.
- `forkSession(cwd, id, { upToMessageId, title })` is already on the `AgentRuntime` interface and wired at `POST /api/sessions/:id/fork`.
- `AdditionalContext` (ADR-0273) is the runtime-neutral per-turn context bag: server owns _what_ context exists, each adapter owns _how_ it renders. `ContextKind = 'git_status' | 'ui_state' | 'queue_note' | 'env' | 'relay_context'`.
- Sender identity already flows for channel sessions: `senderName`/`channelName` → `Sender:`/`Chat:` lines → `originLabel` (spec `channel-sender-identity`).
- The Slack relay adapter already maps Slack threads to sessions (`thread_ts`, `threadTracker.isParticipating`) and **already uses an emoji reaction as a typing indicator** (⏳ via `startTyping`).
- `AgentAvatar` and `AgentIdentity` components already exist in `entities/agent/ui/`.

So: the identity data, the fork primitive, the context seam, the durable event spine, and the avatar component all exist. What is missing is an author on the message, a place to put DorkOS-owned message metadata, and a thread model.

## Research

### How Slack actually composes the list

- Full-bleed horizontal rules are **list-level rows**, not message decoration: day dividers with a centered pill label, and a red "New messages" rule anchored to a per-user read cursor that persists until you leave the channel.
- Identity gutter on the left; name + timestamp render only on the **first message of an author group**; continuations hang-indent under the gutter with a hover-revealed timestamp. Grouping breaks on author change, on a time gap, and on a day boundary.
- Hover reveals a floating action toolbar (react, reply in thread, more). Slack deliberately delays the hover treatment to avoid strobing as the pointer crosses rows.
- Threads: `thread_ts` on the parent, replies hidden from the channel by default, a "N replies" summary row in the channel, and an explicit `reply_broadcast: true` to surface a _reference_ (not the reply) back in-channel. Slack's docs recommend using broadcast sparingly.

### How other systems model threads

| System      | Model                                                                | Consequence                                                                                             |
| ----------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Slack**   | `thread_ts` pointer on a shared message store; opt-in broadcast      | Threads are a display grouping. Cheap. Threads are invisible to the channel.                            |
| **Discord** | Thread is a real child channel (own id, participants, auto-archive)  | Strong isolation, own lifecycle; nothing flows back.                                                    |
| **Matrix**  | `m.relates_to` / `rel_type: m.thread` relation, one level deep       | General relation model (same mechanism serves reactions and edits); federation makes completeness hard. |
| **Zulip**   | Every message carries a **topic** — threading is mandatory, up front | No braiding, trivially skimmable; costs the user a naming decision per message.                         |

Zulip's critique of Slack is the one that matters for us: threads created _after the fact_ braid conversations together and have to be untangled later. With N agents posting concurrently, braiding is the default failure mode, not the edge case.

### How agent products handle thread context

This is where the prior art is most useful, and it is remarkably consistent:

- **Slack's own AI-agent guidance** ([Context management](https://docs.slack.dev/ai/agent-context-management/)) explicitly names re-injection as the anti-pattern: _"Don't refetch entire threads."_ Its recommended shape is a **targeted slice** plus a persistent structured state object — `{ goal, constraints, decisions, artifacts, sources }` — carried between turns, with **progressive summarization** of older interactions. Depth comes from _tools_ (`conversations.replies` for a thread, `conversations.history` for the surrounding channel, `assistant.search.context` for the workspace), not from a bigger prompt.
- Agent harnesses converged on the same shape by bug report. openclaw #12630 and #2608, and hermes-agent #23918/#6345, are all the same defect: an agent replying in a thread saw only the triggering message and answered nonsense. Every fix was the same — detect `thread_ts`, fetch a **bounded** slice (default ~20 messages) via `conversations.replies`, inject it, and expose channel history as an explicit agent _tool_ rather than pushing it.

The pattern, stated plainly: **push a small bounded digest, expose depth as a pull tool.** That is exactly the peripheral-awareness model you described.

## The thread question

### Why we can't just copy Slack

In Slack a conversation is a passive record, so a thread can be a pure display grouping. In DorkOS a conversation is an **active runtime context** — a live agent with a context window, a working directory, and a lock. So a thread is necessarily _some_ kind of second context, and the design question is what it inherits, what it learns, and what it emits.

Three properties, decided independently:

### 1. Inheritance — what the thread starts knowing

**Recommendation: reference, not fork.** A thread opens as a child conversation seeded with the parent message plus a bounded slice of the preceding root messages, delivered as a structured context entry. It does **not** call `forkSession`.

Rationale: forking copies an entire runtime context. Forking a 200k-token session to ask _"why did you choose Zod here?"_ is absurd, per-runtime fork semantics differ, and a fork's context freezes at the fork point — it can never learn what happens next in the main conversation, which is the one property we most want. **Threads are not forks.** `forkSession` stays what it already is: the explicit "branch this conversation and take it somewhere else" action (spec `session-rename-fork`), which is a different user intent and should keep a different name in the UI.

Escalation path: a thread that turns into real work gets promoted — "make this a branch" — which _does_ fork and takes a worktree. That is the honest boundary between a conversation and a task.

### 2. Ambient awareness — what the thread learns while it runs

**Recommendation: push a digest, pull on demand.** This is the "person" model, and it decomposes cleanly onto seams we already have.

**Push** — a new `ContextKind` (`conversation_context`) assembled server-side in `context-assembler.ts` and rendered per-runtime by each adapter, exactly like `git_status` is today. It carries, all capped:

- the thread's own header as a structured state object — `{ goal, constraints, decisions, artifacts }`, Slack's recommended shape, updated as the thread progresses rather than re-derived;
- **root-level messages since the thread opened**, as headlines only (author + ~140 chars, capped at ~10, older ones collapsing to a rolled-up line);
- **sibling thread headlines** — title, status, last activity. Not contents.

**Pull** — operator tools (`conversation_read(scope, id, limit)`) so an agent that needs the actual text can ask. This lands naturally in the agents-as-operators program, which is already adding operator verbs to both MCP servers and the CLI, and it mirrors `conversations.replies` / `conversations.history`.

That combination is the answer to your framing: focused working memory, bounded peripheral vision, and the ability to look when something looks relevant. Push is what a person passively retains; pull is them scrolling up.

### 3. Propagation — what the outside learns from the thread

**Recommendation: summaries up, never contents.**

- The main list gets a **thread-summary row** (participants, reply count, status) — Slack's "N replies", which is a list row, not a message.
- On resolve (or an explicit _broadcast_ action), a one-line result rung lands in the main conversation and enters the parent agent's next-turn digest. This is `reply_broadcast`, but automatic and compressed.
- The parent's context **never** receives the thread's transcript. That is the whole point of threading.

Without this, two agents redo each other's work; with the full transcript, the parent's context is exactly as braided as if threads didn't exist.

### 4. Sibling awareness

**Recommendation: headlines only, via the parent's digest. No direct sibling channel.**

N threads × N threads is combinatorial, and both Slack and Discord ship _zero_ sibling awareness without anyone missing it. Headlines give the realistic human level — "I know someone's on the auth bug" — at fixed cost, and a curious agent can pull.

### 5. The hazard chat apps never have to solve: concurrent writers

Slack threads can't corrupt a git repo. Ours can. Two threads whose agents both edit the working tree will collide, and this repo already has the rule for it: **one checkout, one writer**.

Policy — **settled** in `specs/rooms/01-ideation.md` (A′-policy):

- **Default:** threads are advisory/read-oriented. They share the parent's `cwd`.
- **Escalation:** promoting a thread to a branch allocates a worktree, at which point it is a peer session with its own tree.

**Correction to this document's original proposal.** It claimed the write lock "extends the existing `session-lock` / `X-Client-Id` machinery rather than inventing a second one." That is wrong. `SessionLockManager` is keyed on `sessionId` (`apps/server/src/services/session/session-lock.ts:24`) and guards several clients contending for **one session**. The hazard here is one resource with **many sessions** — the orthogonal case, which that machinery neither covers nor could be extended to cover. No cwd-, worktree-, or resource-keyed lock exists anywhere in the repo; it needs a new primitive keyed on the resolved path.

That primitive is tracked separately as **A′-mechanism** and is **not** thread-gated, so it does not block threads. DOR-500 measured why it matters and what it should be keyed on: at 6 concurrent agents on one working tree, 57 / 6 / 18 canary lines of 360 survived across three runs, against 43 / 55 / 61 of 180 per tree when the same 6 agents were split across two trees. Tree-sharing is the collision, so the tree — not the conversation and not the room — is what a lock must be keyed on. (Interleave rate, not corruption rate: the canary is a deliberately non-atomic read-modify-write and an atomic writer loses nothing. See `research/20260725_q3-contention-preregistration.md`.)

## Reactions

Two distinct products share one gesture, and conflating them is the trap:

1. **Affect** — 👍 on a message. Ambient, social, free.
2. **Control** — the valuable one here. In an agent OS a reaction is the lowest-friction command surface in the entire cockpit: no typing, no turn, no context switch.

Design positions:

- **Reactions do not trigger a turn by default.** Triggering on every reaction makes the list jumpy and burns tokens. Reactions accumulate and arrive in the next turn's digest.
- **A small registered set of actuator reactions does trigger** — e.g. 🔁 retry, ✅ approve, 📌 pin-to-memory, 👎 record-preference. Registered through the capability registry rather than hardcoded, so the set is inspectable and extensible.
- **Agents react too.** 👀 = "seen, I'm on it" is a better status affordance than another spinner, and it is what real Slack bots do. In-repo precedent: our own Slack adapter already uses ⏳ as a typing indicator.
- The `slack-tool-approval` spec previously rejected reaction-based approval — but for **Slack transport** reasons (Socket Mode doesn't reliably push reaction events). Those reasons don't apply in-cockpit, where we own the event spine.

## Storage and identity seams

**Author identity — the load-bearing schema change.** `role: 'user' | 'assistant'` becomes an author:

```
author: { kind: 'human' | 'agent' | 'system', id, displayName, avatar? }
```

`role` stays as the runtime-facing projection (a runtime still only knows user/assistant). Asks #2, #3 and #4 all depend on this; grouping switches from role to author, which incidentally fixes the case where two different agents' consecutive messages currently merge into one visual group.

**Reactions + thread registry live in a DorkOS-owned sidecar**, not in any transcript — because DorkOS cannot write to runtime-owned storage. SQLite via `@dorkos/db`, keyed `(sessionId, messageId)`, following the existing agent-storage precedent. Delivery rides the durable SSE spine with new event types (`reaction_added`, `reaction_removed`, `thread_update`), so replay, gap-filling and cross-client sync come for free.

**Risk that must be settled first — message-id stability.** claude-code derives message ids from the JSONL `uuid`, but falls back to `crypto.randomUUID()` for records lacking one (`transcript-parser.ts:248,344,392,416,528,579`) — an unstable id would orphan every reaction attached to it on re-read. Codex and OpenCode are unverified. A "stable message id across re-reads" requirement belongs in the shared `runtimeConformance` suite before reactions ship.

## List-structure change

`MessageList` currently virtualizes `ChatMessage[]`. Day rules, unread markers and thread-summary rows are **not messages**. Introduce a derived row union computed once:

```
ListRow = { kind: 'message' } | { kind: 'day-divider' } | { kind: 'unread-divider' } | { kind: 'thread-summary' }
```

Dividers must be real virtualized rows — decorating a message with an absolute `h-px` (today's approach) cannot produce a full-bleed rule between groups and will fight the virtualizer's measurement and end-anchoring.

The unread rule needs a per-client read cursor; `X-Client-Id` already exists, so `lastReadSeq` per `(session, client)` is a small addition. Note that an unread divider only becomes _meaningful_ once conversations progress while you're not watching — which is precisely the multi-agent premise.

**The tradeoff to name explicitly:** Slack's layout costs us the right-aligned user bubble. Right-alignment cannot express four participants — but it is a visible part of the product's current identity, so this is a deliberate change, not a detail.

## Open decisions for SPECIFY

Decisions 1 and 6 are **resolved** in `02-specification.md` (D1: the bubble is dropped; D4: the cursor is client-local). The rest belong to the phase-2 and phase-3 specs.

1. ~~Right-aligned user bubble — drop entirely, or keep as a single-participant density mode?~~ Resolved: dropped (D1).
2. Thread creation trigger: hover "reply in thread" only, or also auto-thread agent-initiated sub-work (subagent blocks are already proto-threads)?
3. ~~Do threads get their own runtime session, or one runtime session multiplexed by a thread key?~~ **Resolved: their own.** ADR-0255 binds a session to a runtime at first write and never rebinds, so a multiplexed session cannot hold agents on two runtimes — and a mixed-runtime thread is exactly the case the multiplexed option existed to make cheap. See ADR 260726-170125 and `specs/rooms/02-specification.md` §2 (`room_sessions`).
4. Digest budget: caps for root headlines, sibling headlines, and total token ceiling.
5. Actuator reaction set for v1, and whether actuators are user-configurable at launch.
6. ~~Read cursor scope: per client, per (client, session), or per human identity once accounts land?~~ Resolved for phase 1: client-local `localStorage` per session (D4); revisit when accounts land.
7. Thread lifecycle: explicit resolve, auto-resolve on inactivity, or both?
8. ~~Whether the write-lock policy is thread-scoped or conversation-tree-scoped.~~ **Resolved: neither.** The lock is keyed on the resource — a containment relation over paths — not on any conversation shape. Tracked as A′-mechanism; see the correction above.

## Message-id stability — verified 2026-07-25

The blocking risk for reactions was investigated across all three runtimes. Result: **less dangerous than feared on the read-to-read axis, and more dangerous on the streaming axis.**

| Runtime         | Read-to-read       | Detail                                                                                                                                                                                                                                                                     |
| --------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **claude-code** | Stable in practice | Ids are the JSONL `uuid`. Across 58 local transcripts (28,628 user+assistant records) **zero** lacked one. But `SDKUserMessage.uuid` is typed _optional_, and the `\|\| crypto.randomUUID()` fallback would silently re-mint on every read — a latent trap, not dead code. |
| **codex**       | Stable             | `user-<seq>` / `assistant-<seq>` from the durable, monotonic `session_events` seq. Proven stable across a real restart (`session-event-store.test.ts:112-150`).                                                                                                            |
| **opencode**    | **Conditional**    | Native path uses the sidecar's own durable id; the fallback path (sidecar down) uses the `user-<seq>` scheme. **The same message gets a different id depending on which path answered** — the one real read-to-read flip in the system.                                    |

**The bigger finding — streaming ids are synthetic for every runtime.** An in-flight turn renders under the constant ids `__in_progress_turn__` and `__optimistic_user__` (`project-session-turn.ts:32,35`), which `use-turn-end-reconcile.ts:127` discards wholesale when the turn settles. A reaction attached mid-stream would be orphaned unconditionally, on every runtime.

Consequences for phase 2, now settled rather than open:

1. **Gate the reaction affordance on settled messages** (`!message._streaming`). This is a one-line UI rule that removes the entire class of problem.
2. Add a **repeated-read id-equality assertion** to the shared `runtimeConformance` history block (`packages/test-utils/src/runtime-conformance.ts:396-413`) — it would catch the claude-code fallback if it ever fires and passes trivially for the others.
3. OpenCode's dual-path flip is structural and not coverable by the generic suite. Document it with a dedicated test asserting the ids _do_ differ across a forced native-read failure, rather than asserting a stability that isn't there.
4. Note `getLastMessageIds()` is unused scaffolding today (implemented only for claude-code, zero production callers) — it is not a reconciliation path phase 2 can lean on.

## Risks

- ~~**Message-id instability** orphans reactions — blocking for ask #3.~~ Investigated above; reduced to three concrete, cheap mitigations. No longer blocking.
- **Virtualizer regressions.** The measurement path carries hard-won fixes (zero-guard cache fallback, end anchoring). Mixed row heights and expanding thread summaries need browser verification, not just jsdom.
- **Context-cost creep.** Every digest is tokens on every turn of every thread. The cap is a product decision, not an implementation detail, and it needs to be visible in the UI.
- **Scope.** Asks #3 and #4 are each a spec of their own. Landing #1 and #2 first (rows + author identity) is the enabling refactor for both and is independently shippable.

## References

- [Slack — Context management for AI agents](https://docs.slack.dev/ai/agent-context-management/)
- [Slack — `chat.postMessage` (`thread_ts`, `reply_broadcast`)](https://api.slack.com/methods/chat.postMessage) · [`conversations.replies`](https://api.slack.com/methods/conversations.replies)
- [openclaw #12630 — Slack thread messages lack thread history context](https://github.com/openclaw/openclaw/issues/12630) · [openclaw #2608 — auto-fetch thread history](https://github.com/openclaw/openclaw/issues/2608)
- [MSC3440 — Threading via `m.thread` relation](https://github.com/matrix-org/matrix-spec-proposals/pull/3440) · [MSC2675 — server-side aggregations](https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/2675-aggregations-server.md)
- [Why Zulip — topic-based threading](https://zulip.com/why-zulip/) · [Why I like Zulip instead of Slack or Discord](https://www.lesswrong.com/posts/R8fADFuJeYo7QxTtH/why-i-like-zulip-instead-of-slack-or-discord)
- In-repo: ADR-0273 (additional context), ADR-0264/DOR-189 (durable event log), ADR-0310 (runtime-owned sessions), specs `channel-sender-identity`, `session-rename-fork`, `slack-tool-approval`, `agents-as-operators`, `capability-registry`
