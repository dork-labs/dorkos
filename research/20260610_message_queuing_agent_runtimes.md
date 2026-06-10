---
title: 'Message Queuing Across the Client and Agent Runtimes — How Should Runtimes Accept Mid-Turn Messages?'
date: 2026-06-10
type: research
status: active
linear: DOR-82
project: Chat Session Reliability
tags:
  [
    agent-runtime,
    message-queuing,
    claude-agent-sdk,
    streaming-input,
    interrupt,
    steering,
    codex,
    opencode,
    amp,
    session-streaming,
    adr-0263,
    adr-0264,
  ]
---

# Message Queuing Across the Client and Agent Runtimes

> Companion to Linear issue **DOR-82**. The issue is the actionable summary + decision points; this is the full reference with file:line citations, code excerpts, the SDK API surface, and the cross-runtime comparison.

## TL;DR

- **Today the runtime has no concept of accepting a message mid-turn.** Concurrency is blocked crudely at the HTTP layer (`409 SESSION_LOCKED`), and all queuing intelligence lives in the React client as ephemeral state that is lost on refresh.
- **The Claude Code runtime is _not_ persistent** (confirmed): it is a hybrid of **resume-per-message** + **held-streaming-input-within-a-single-turn**. It does not keep a long-lived process you feed across turns.
- **The Claude Agent SDK already models everything we want** in streaming-input mode: a built-in priority queue (`priority: 'now'|'next'|'later'`), context-staging without a turn (`shouldQuery: false`), live input (`streamInput()`), and `interrupt()`. Queue and interrupt are **distinct primitives**.
- **The industry has converged on a four-pattern taxonomy** — block / queue-to-end / interrupt-restart / **steer-inject**. Codex and Amp model "steer" as a first-class verb distinct from "interrupt." OpenCode's queue lives in its **client**, not its server.
- **Recommendation:** standardize **three dispositions** (queue / steer / interrupt) at the `AgentRuntime` boundary; make the **server own the queue** (per ADR-0264's trigger-only POST); have each adapter declare capabilities and fall back gracefully; make the well-known failure modes explicit and tested.

---

## 1. Current state — Client (`apps/client`)

The client already distinguishes "session busy" from "streaming" and supports a compose-next queue, but it is all ephemeral React state.

- **Input blocked while busy.** The textarea and send button are disabled on `sessionBusy`:
  - `layers/features/chat/ui/input/ChatInput.tsx:222` — `disabled={sessionBusy}`
  - `layers/features/chat/ui/input/InputActionButton.tsx:118` — `disabled={buttonState === 'send' && sessionBusy}`
  - `sessionBusy` is a **lock-recovery** flag set on a `409 SESSION_LOCKED` response and cleared after `TIMING.SESSION_BUSY_CLEAR_MS` (`use-session-submit.ts:193–217`). It is **separate** from `status === 'streaming'`.
- **Compose-next queue while streaming.** While `status === 'streaming'` the composer switches its primary action to **Queue** (`use-input-keyboard.ts:127–135`). The queue is a client-side FIFO (`model/use-message-queue.ts`):
  - Auto-flush on the `streaming → idle` transition (`use-message-queue.ts:58–79`).
  - The first flushed message is annotated: `"[Note: This message was composed while the agent was responding to the previous message]\n\n${item.content}"` (`use-message-queue.ts:66`).
  - This is **ADR-0104** — ephemeral, client-only, lost on refresh, not server-aware, not multi-window-synced.
- **Transport contract** (`packages/shared/src/transport.ts:244`):

  ```ts
  sendMessage(
    sessionId: string,
    content: string,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
    cwd?: string,
    options?: { clientMessageId?: string; uiState?: UiState }
  ): Promise<void>;
  ```

  - Impl POSTs to `/sessions/:id/messages`, streams SSE, special-cases `409 SESSION_LOCKED` (`session-methods.ts:200–241`). No transport-level queuing.

- **Stream lifecycle** is a module-level singleton `StreamManager` — one stream per session, new stream aborts the old one, handles SDK create-on-first-message id remap (`model/stream/stream-manager.ts`). No queue at this layer.
- **In flight (feat/chat-stream-reconnection / DOR-81):** the queue is being moved out of component-local `useState` into a per-session store keyed by **canonical** `sessionId`, with flush pinned to the origin session.

---

## 2. Current state — Server / runtimes

### 2.1 Concurrency is blocked at HTTP, not modeled in the runtime

`POST /api/sessions/:id/messages` acquires a session lock; a second client gets `409` immediately and the request dies — **no queue, no acceptance, no runtime-level coordination**:

- `apps/server/src/routes/sessions.ts:331–345` — `acquireLock(sessionId, clientId)` → on failure returns `{ error: 'Session locked', code: 'SESSION_LOCKED', lockedBy }`.
- `services/runtimes/claude-code/sessions/session-lock.ts:23–47` — lock keyed by `sessionId`, released on SSE `res.close`, 5-minute TTL.
- `apps/server/src/config/constants.ts` — `SESSIONS.LOCK_TTL_MS = 5 * 60 * 1000`.

### 2.2 The `AgentRuntime` interface has no queuing concept

`packages/shared/src/agent-runtime.ts`:

- `sendMessage(sessionId, content, opts?): AsyncGenerator<StreamEvent>` (line ~253)
- `interruptQuery(sessionId): Promise<boolean>` (line ~334)
- Lock methods: `acquireLock` / `releaseLock` / `isLocked` / `getLockInfo` (lines ~439–443)

There is **no** method for accepting a message mid-turn, no disposition/priority, no steer.

### 2.3 The Claude Code runtime is NOT persistent (confirmed)

Each `sendMessage()` creates a **fresh SDK `query()`** that resumes the prior SDK session:

- `services/runtimes/claude-code/messaging/message-sender.ts:229` — sets `sdkOptions.resume = session.sdkSessionId` once `session.hasStarted`; there's a retry path (`isResumeFailure`, `MAX_RESUME_RETRIES`) that restarts fresh on stale resume.
- `message-sender.ts:346` — `const agentQuery = query({ prompt: heldPrompt.prompt, options: sdkOptions }); session.activeQuery = agentQuery;`
- `services/runtimes/claude-code/sdk/sdk-utils.ts` — `createHeldUserPrompt()` yields the first user message, then `await`s a held promise so the streaming-input generator never completes, holding stdin open **within the turn** long enough to call control methods (`getContextUsage()`, `setPermissionMode()`); `close()` resolves the promise to drain + exit.
- `agent-types.ts:22–65` — `AgentSession` tracks `activeQuery` (live) and `lastQuery` (post-turn control).

So the model is **resume-per-message + held-stream-within-turn** — a hybrid, not a long-lived feed-forever process.

### 2.4 Interrupt exists, but no public endpoint drives it outside abort

`services/runtimes/claude-code/sessions/session-store.ts:334–349`:

```ts
async interruptQuery(sessionId: string): Promise<boolean> {
  const session = this.findSession(sessionId);
  if (!session?.activeQuery) return false;
  try { await session.activeQuery.interrupt(); return true; }
  catch { try { session.activeQuery.close(); return true; } catch { return false; } }
}
```

Graceful `interrupt()` with a forceful `close()` (subprocess kill) fallback.

### 2.5 What happens today if a second message arrives mid-turn

1. Client A holds the lock, A's turn streams.
2. Client B `POST`s → `acquireLock` fails → **HTTP 409** → request dies. No queue, no runtime awareness.
3. A's stream continues to `done`; lock releases on close.

### 2.6 Test runtimes

- `services/runtimes/test-mode/test-mode-runtime.ts:74` — yields a pre-loaded scenario generator.
- `packages/test-utils/src/fake-agent-runtime.ts:62` — `vi.fn()` async-gen, scenario-driven. No locking/concurrency. (Interface additions will break-compile these intentionally.)

---

## 3. Claude Agent SDK deep dive (`@anthropic-ai/claude-agent-sdk@0.3.168`)

> Verified against the installed `sdk.d.ts` (ground truth for the version we ship), cross-checked with the live docs. **The "V2 session API" (`unstable_v2_createSession`/`send()`/`stream()`) was removed in 0.3.142 — ignore it.**

### 3.1 Two input modes for `query()`

```ts
export declare function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query; // Query = AsyncGenerator<SDKMessage, void> + control methods
```

- **String (single-message):** one-shot. **No** image attachments, **no** queueing, **no** interruption — and crucially, **the control methods are unavailable** in this mode.
- **Streaming input (`AsyncIterable<SDKUserMessage>`):** the **preferred** mode. Long-lived input channel; supports queueing, interruption, permission surfacing, session management. All control methods require this mode.

### 3.2 `SDKUserMessage` carries the queuing controls

```ts
export declare type SDKUserMessage = {
  type: 'user';
  message: MessageParam;
  parent_tool_use_id: string | null;
  priority?: 'now' | 'next' | 'later'; // built-in priority queue
  shouldQuery?: boolean; // false → append to transcript, do NOT start a turn
  session_id?: string;
  // …
};
```

- **`priority`** — built-in priority queue for user messages. Maps (by name) to interrupt-now / after-current-turn / defer. ⚠️ **Low confidence:** exact scheduling is inferred from the names, **not documented in prose** — verify empirically before relying on `'now'` for preemption.
- **`shouldQuery: false`** — doc comment: _"the message is appended to the transcript without triggering an assistant turn. It will be merged into the next user message that does query."_ This is the mechanism to **stage context without a turn** — directly answers the user's "is there a way to pass in messages that would not stop the current process?"

### 3.3 Pushing more messages into a running query — two ways

1. Keep `yield`-ing from the async generator you passed as `prompt` (you must coordinate when to yield — typically `await` an external signal/queue inside the generator).
2. `query.streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>` — feed additional messages without threading through the original generator closure.

### 3.4 Queue ≠ interrupt

The docs' own sequence diagram labels "Queue Message" and "Interrupt/Cancel" as **separate** steps; the benefits card says _"send multiple messages that process sequentially, with ability to interrupt."_ So the default for a mid-turn push is **enqueue → run after the current turn**, and preemption is opt-in via `interrupt()` (then send) or, presumably, `priority: 'now'`.

### 3.5 Other `Query` control methods (streaming-input-only)

`interrupt()`, `setPermissionMode()`, `setModel()`, `applyFlagSettings()`, `streamInput()`, `stopTask(taskId)`, `close()`, `rewindFiles()`, `getContextUsage()`, `mcpServerStatus()`, `reconnectMcpServer()`, `toggleMcpServer()`, `setMcpServers()`, plus introspection (`supportedCommands/Models/Agents`, `initializationResult`, `accountInfo`).

### 3.6 Persistence: two axes + tradeoffs

| Dimension                                  | Persistent streaming query (one long-lived `query()`)                                                  | New `query()` per message + `resume` (what DorkOS does)         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Control methods (`interrupt`/`setModel`/…) | Full access                                                                                            | Unavailable in string mode                                      |
| Latency / warm state                       | Subprocess + MCP + prompt cache stay warm                                                              | Cold-ish: reload history, re-spin subprocess/MCP                |
| Images / queue / mid-turn interrupt        | Supported                                                                                              | Not in string mode                                              |
| Failure blast radius                       | Whole session affected if the process dies; must manage lifecycle (`close()` in `finally` or it leaks) | Per-turn isolation; crash loses one turn, trivially restartable |
| Statelessness / horizontal scale           | Hard — pins session to one process                                                                     | Easy — any worker resumes by id (Lambda-friendly)               |
| Crash recovery / server restart            | Lost                                                                                                   | Natural: resume from persisted session id                       |
| Coordination complexity                    | You own generator flow-control                                                                         | Simple request/response per message                             |

DorkOS deliberately took the hybrid (resume-per-message for durability, held-stream-within-turn for control-method access).

### 3.7 SDK-recommended "chat while busy" pattern

Use streaming-input mode; always let the user type and buffer in **our** layer; then per message choose **queue** (default sequential), **interrupt-and-replace**, or **stage context** (`shouldQuery: false`); hold the input stream open for warmth; wire interrupt→close fallback; persist `session_id` for resume.

---

## 4. Cross-runtime survey + taxonomy

### 4.1 The four patterns

- **(a) Block** input until idle. (Aider, legacy REPLs.)
- **(b) Queue** → send at end of turn. (Gemini default, OpenCode, Amp default, Codex `Tab`.)
- **(c) Interrupt** + restart turn. (Aider Ctrl-C; Esc in most TUIs.)
- **(d) Steer / inject** into the live turn without stopping it. (Codex `turn/steer`/Enter; Amp `Enter Enter` / `{steer:true}`; Gemini "model steering" — weak.)

The leading TUIs now ship (b)+(c)+(d) on different keys. Pattern (a) is legacy.

### 4.2 Comparison matrix

| Runtime                    | Block (a)               | Queue→end (b)                                        | Interrupt (c)                             | Steer live (d)                                                 | Host-drivable API                                                                                                                           |
| -------------------------- | ----------------------- | ---------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Codex CLI** (app-server) | —                       | Yes (`Tab`)                                          | Yes (`turn/interrupt`)                    | **Yes** (`turn/steer`, requires `expectedTurnId`)              | **Strong** — JSON-RPC 2.0 over stdio/WS/Unix socket, full turn lifecycle (`turn/started`, `item/*`, `agentMessage/delta`, `turn/completed`) |
| **OpenCode**               | —                       | Yes — **queue is in the TUI client, not the server** | Yes (`/abort`, cooperative)               | Partial (temp-block wrap)                                      | Good — OpenAPI HTTP + SSE (`/session/:id/message` sync, `/prompt_async`, `/abort`, `/event`); host must own the queue                       |
| **Amp**                    | —                       | Yes (default)                                        | Yes (`Esc Esc`)                           | **Yes** — `"steer": true` in stream-json input (`Enter Enter`) | Good — stdin/stdout streaming JSON + TS SDK; no HTTP server                                                                                 |
| **Gemini CLI**             | —                       | Yes (type+Enter)                                     | Yes (`Esc`)                               | Weak (`/inject` proposal closed not-planned)                   | Limited — one-shot `-p`, no streaming turn protocol                                                                                         |
| **Aider**                  | **Yes** (blocking REPL) | No                                                   | Yes (`Ctrl-C`, partial response retained) | No                                                             | None                                                                                                                                        |

### 4.3 Lessons that shape our design

1. **One verb is not enough.** Codex and Amp model send/queue, interrupt, and steer as **distinct** ops. Folding them into a single `sendMessage` will leak. Amp's `{ steer: true }` envelope flag + a separate `interrupt(turnId)` is the most portable shape.
2. **Don't assume the backend owns the queue.** OpenCode's server is single-flight + abort; the queue lives in its TUI. A runtime-neutral abstraction should **own the queue server-side**, treating native runtime queuing as an optimization.
3. **`expectedTurnId` matters for steer.** Codex requires it and rejects steer when there's no active turn or wrong turn kind (review/compaction). A steer call must carry the current turn id and handle "turn already ended" races.
4. **The known bugs are the spec.** Every queue-capable tool ships the same failure modes:
   - Queued messages dropped on abort — OpenCode #5333.
   - Queued prompts firing during a pending permission/confirmation — Gemini #17719, OpenCode #2609 (`isBusy()` misses `compacting`).
   - Premature dequeue — OpenCode #15696.
   - Queue serialization breaking prompt caching — OpenCode #21518.
   - Queued-message interleave during tool calls — Gemini #17282.

### 4.4 Natural integration targets

- **Codex app-server** (JSON-RPC; richest, closest to our own SQ/EQ transport shape).
- **OpenCode** HTTP+SSE server (queue-less but clean abort + event stream).
- **Amp** over stdio streaming JSON (`{steer:true}` is a clean precedent for our message envelope).
- Gemini/Aider are TUI-first; they'd need wrapping rather than a protocol adapter.

---

## 5. How this fits the in-flight architecture (ADRs 0263–0267 / specs/chat-stream-reconnection)

- **ADR-0264** already decouples turn execution from the POST: **POST becomes trigger-only** (enqueue/start, return canonical id); tokens flow through a server-owned durable, resumable SSE (`SessionStateProjector` → `GET /api/sessions/:id/events`, idempotent replay via `Last-Event-ID`, bounded RingBuffer). **This is exactly the seam where a server-owned message queue belongs.**
- **ADR-0263** gives the runtime-neutral `SessionEvent` contract (monotonic `seq`) + pluggable persistence — mid-turn acceptance and queue depth must surface here as events, not ad-hoc client state.
- **ADR-0265 / 0266** (global multiplexed status stream, always-on hydration) — queue state must be **server-held and synced to all windows**; ADR-0104's ephemeral client queue is superseded.
- **ADR-0267** (canonical id in URL) — queue keyed by **canonical** session id, remapped on first send (DOR-81).
- **Gap flagged in the spec:** the session snapshot schema has **no `queuedMessages`/queue-depth field**, and stateless/per-turn runtimes can't auto-flush across turns. Both need design.

---

## 6. Options analysis — the approaches to "accept a message mid-turn"

The user's framing maps cleanly onto the SDK's own primitives. For each, what it does, when to use it, and how it maps to the SDK / other runtimes.

### Option A — Queue to end of turn (default, "calm")

- **Behavior:** accept the message, hold it, dispatch when the current turn finishes.
- **SDK:** `priority: 'next'` (or `'later'`) in streaming-input mode, or our own server-side queue that re-submits via resume.
- **Others:** Codex `Tab`, OpenCode TUI queue, Amp default, Gemini default.
- **Pros:** predictable, preserves in-flight work, matches the SDK default. **Cons:** message effect is delayed; needs explicit handling of abort/permission-prompt edge cases.

### Option B — Steer / inject into the live turn (don't stop it)

- **Behavior:** push the user's text into the running turn so the model course-corrects mid-flight without restarting.
- **SDK:** yield a message into the open stream / `streamInput()` while the turn runs (queued and surfaced at the next step); `shouldQuery: false` to stage context that merges into the next query without itself starting a turn.
- **Others:** Codex `turn/steer` (needs `expectedTurnId`), Amp `{steer:true}`.
- **Pros:** fastest course-correction, no lost work, great UX for "also do X" / "actually, focus on Y." **Cons:** semantics vary per runtime; some turn kinds reject steering; race with turn completion; weakest cross-runtime guarantee (OpenCode/Gemini partial).

### Option C — Interrupt and restart with new context

- **Behavior:** abort the current turn, then send the new message as a fresh turn.
- **SDK:** `interrupt()` then send (our `interruptQuery()` already does interrupt→close fallback).
- **Others:** Codex `turn/interrupt`, OpenCode `/abort`, Amp `Esc Esc`, Gemini `Esc`, Aider `Ctrl-C`.
- **Pros:** immediate redirect; clean when the user wants to stop. **Cons:** loses/abandons in-flight tool work; partial-output handling differs per runtime.

### Option D — Stage context without triggering a turn

- **Behavior:** attach information for the agent to use, without starting or stopping anything.
- **SDK:** `shouldQuery: false`.
- **Pros:** non-disruptive "FYI / here's a file." **Cons:** Claude-specific today; needs a neutral representation for other runtimes (likely emulated by buffering until the next turn).

### Cross-cutting: who owns the queue?

- **Server-owned (recommended):** DorkOS holds the queue (per ADR-0264), keyed by canonical session id, synced via durable + global streams. Native runtime queuing (SDK `priority`/`streamInput`, Codex steer) is an optimization a given adapter may use.
- **Runtime-owned:** delegate to the backend's native queue. Cleaner where it exists (SDK, Codex, Amp), **absent** in OpenCode's server — so this can't be the universal contract.

---

## 7. Open questions / decision points (mirrors DOR-82)

1. **Interface shape:** explicit verbs (`enqueueMessage` / `steer(turnId, content)` / `interruptQuery`) vs. a single `sendMessage(…, { disposition })` envelope carrying `disposition`/`priority`/`shouldQuery`-equivalent? (Lean: explicit `interrupt` + a `sendMessage` envelope with `disposition`.)
2. **Queue ownership:** server vs. runtime adapter, and the fallback contract for queue-less runtimes (OpenCode-style).
3. **Default disposition** for a mid-turn message: queue-to-end vs. steer vs. user-chosen-per-message; what UX exposes the others.
4. **Claude runtime:** move to a persistent streaming query (native `priority`/`streamInput` + warm cache) or keep resume-per-message and queue at our layer?
5. **Replace `409 SESSION_LOCKED`** with accept-and-queue; decide multi-_client_ (not multi-window) concurrent send semantics — merge into one queue or stay single-writer.
6. **Known failure modes** — explicit decision + test for each (drop-on-abort, fire-during-permission-prompt, premature dequeue, cache-busting serialization, interleave-during-tool-call).
7. **Queue persistence & restart:** do not-yet-started queued messages survive a server restart? (In-process RingBuffer loses in-flight turns today.)
8. **Surface in the contract:** add `queuedMessages`/queue-depth to the session snapshot + a queue event type on the durable stream.

---

## 8. Recommendation (to validate, not yet ratified)

1. **Standardize three dispositions** at the `AgentRuntime` boundary — **queue** (default; send at end of turn), **steer** (inject into live turn where supported), **interrupt** (abort then send) — modeled on the Codex/Amp consensus. Keep `shouldQuery:false`-style context-staging as a fourth, optional capability.
2. **Server owns the queue** (per ADR-0264's trigger-only POST), keyed by canonical session id, synced via the durable + global streams (ADR-0263/0265/0266). Native runtime queuing is an optimization.
3. **Each adapter maps the dispositions onto its backend's primitives** and declares a capability set (e.g. `supportsSteer`), with a graceful server-side fallback (queue + resubmit) when a primitive is missing.
4. **Make the known failure modes explicit and tested.**
5. **Replace the HTTP 409 reject** with accept-and-queue once the server-owned queue lands.

### Suggested next steps

- Ratify/refine into ADR(s): (a) the standardized disposition contract on `AgentRuntime`; (b) the server-owned-queue vs runtime-owned-queue boundary.
- File `type/task` issues: interface change, Claude adapter, snapshot/stream queue fields, failure-mode handling.

---

## 9. Sources

**Codebase (this repo):**

- Client: `layers/features/chat/ui/input/ChatInput.tsx`, `InputActionButton.tsx`, `use-input-keyboard.ts`, `model/use-message-queue.ts`, `model/use-session-submit.ts`, `model/stream/stream-manager.ts`, `packages/shared/src/transport.ts`, `layers/shared/lib/transport/session-methods.ts`
- Server: `apps/server/src/routes/sessions.ts`, `services/runtimes/claude-code/{messaging/message-sender.ts, sdk/sdk-utils.ts, sessions/session-store.ts, sessions/session-lock.ts, agent-types.ts}`, `apps/server/src/config/constants.ts`, `packages/shared/src/agent-runtime.ts`
- Architecture: `decisions/0263`–`0267`, `decisions/0104`, `decisions/0204`, `decisions/0262`, `specs/chat-stream-reconnection/{01-ideation.md,02-specification.md}`, `research/20260328_session_state_manager_architecture.md`, `research/20260319_streaming_message_integrity_patterns.md`, `research/20260327_sse_multiplexing_unified_stream.md`

**Claude Agent SDK:**

- `code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode`
- `code.claude.com/docs/en/agent-sdk/typescript`
- `code.claude.com/docs/en/agent-sdk/typescript-v2-preview` (V2 API removed in 0.3.142)
- Installed `@anthropic-ai/claude-agent-sdk@0.3.168` `sdk.d.ts` (`Query`@2198, `query()`@2433, `SDKUserMessage`@3827, `Options.resume/continue/forkSession`@1731/1340/1455)

**Other runtimes:**

- Codex: `github.com/openai/codex/blob/main/codex-rs/app-server/README.md`, `developers.openai.com/codex/app-server`, `developers.openai.com/codex/cli/features`, `codex-rs/docs/protocol_v1.md`
- OpenCode: `opencode.ai/docs/server/`, `opencode.ai/docs/sdk/`, issues #5333 / #2609 / #15696 / #21518
- Amp: `ampcode.com/manual`, `ampcode.com/manual/sdk`
- Gemini CLI: `geminicli.com/docs/reference/keyboard-shortcuts/`, issues #17282 / #17719 / #17197
- Aider: `aider.chat/docs/usage/commands.html`
