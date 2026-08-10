# Persistent session runtime, and the queue / steer / interrupt contract

**Work item:** DOR-1089 · **Slug:** `persistent-session-runtime` · **Id:** `260810-003853` · **Date:** 2026-08-09 · **Stage:** IDEATE

**Source material:** `research/20260610_message_queuing_agent_runtimes.md` (DOR-82, the foundation), a full source trace of `services/runtimes/claude-code/` at `e4b9e1a9b`, the installed `@anthropic-ai/claude-agent-sdk@0.3.224` type surface, and the in-flight DOR-1087 workaround branch (`worktree-dor-1087-phantom-stop`, uncommitted).

Every claim about current behavior below carries a `file:line` pointer verified against the tree at `e4b9e1a9b`. Where a claim could not be verified from source it is labelled **unverified** rather than asserted.

---

## 1) Intent and assumptions

**Task brief.** Move the claude-code runtime off resume-per-message (a fresh `query()` subprocess per turn) onto persistent streaming-input sessions, and standardize three dispositions at the `AgentRuntime` boundary: **queue**, **steer**, **interrupt**, plus capability flags and honest degradation for codex and opencode.

**Shape constraints already decided (not open for re-litigation in SPECIFY):**

1. One persistent `query()` per **ACTIVE** session, with an idle timeout that closes the process.
2. Today's resume path stays, as the crash / restart / cold-start fallback. It is not deleted; it is demoted to a recovery route.
3. The **server owns the message queue** (ADR-0264's trigger-only POST is the seam). Native runtime queuing is an optimization a given adapter may reach for, never the contract.

**Assumptions.**

- The Claude Agent SDK stays at `0.3.224` or newer for the life of this programme. Everything the design leans on (`streamInput`, `priority`, `shouldQuery`, interrupt receipts, `cancel_queued`, `reinitialize`) is present in the installed `sdk.d.ts` and cited in §5.
- Session count per host stays in the tens, not thousands. `SESSIONS.MAX_SESSIONS = 50` (`apps/server/src/config/constants.ts:119`) is the existing ceiling and this work does not raise it.
- DorkOS remains single-process per host. No cross-process session affinity problem is in scope.
- The cockpit's ephemeral compose-next queue (ADR-0104) is superseded by the server queue, but its **UX** (queue chips, edit-in-place, `restore` on refusal) is a requirement to preserve, not a thing to redesign.

**Out of scope.**

- Making codex or opencode persistent. They keep their own process models (ADR-0308, ADR-0309); they only gain the disposition vocabulary and honest capability flags.
- Multi-host / horizontally-scaled session routing.
- The client's composer redesign. This programme changes what the composer can _ask for_, not how it looks.
- `runtime-interrupt-receipts` (spec `260807-231651`) and `runtime-prompt-redelivery` (spec `260807-231653`) remain their own specs. This one **depends on** and **enables** both; see §11 D7.

---

## 2) Problem statement, with evidence

### 2.1 What the claude-code runtime actually does today

`executeSdkQuery` is called once per turn and builds a whole new SDK query each time:

- Resume is set from the prior SDK session id, and anchored: `sdkOptions.resume = session.sdkSessionId` and `sdkOptions.resumeSessionAt = session.lastAssistantUuid` (`apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts:505-531`).
- The prompt is a **held** streaming-input generator that yields exactly one user message, then parks on a promise so the subprocess survives past the `result` message long enough to answer control requests (`apps/server/src/services/runtimes/claude-code/sdk/sdk-utils.ts:73-98`, `:110-112`).
- `const agentQuery = query({ prompt: heldPrompt.prompt, options: sdkOptions }); session.activeQuery = agentQuery;` (`message-sender.ts:690-692`).
- On the first `result` message the sender fetches context usage and subscription usage, then calls `heldPrompt.close()` to release stdin so the process drains and exits (`message-sender.ts:845-864`).
- In the `finally`, the query is demoted to `session.lastQuery` and `session.activeQuery` is cleared (`message-sender.ts:1017-1032`).

So: **resume-per-message plus held-stream-within-turn**. The research report called this a hybrid (`research/20260610_message_queuing_agent_runtimes.md` §2.3); the source confirms it verbatim.

The `AgentRuntime` interface has no vocabulary for any of this. `sendMessage` is the only ingress (`packages/shared/src/agent-runtime.ts:700`), `interruptQuery` is the only mid-turn control (`:794`), and the interface's own doc asserts a guarantee the server does not actually provide:

> "Single-flight per session: callers must not invoke `sendMessage` concurrently for the same `sessionId` — the server's trigger-turn session lock enforces this, so adapters may assume it."
> `packages/shared/src/agent-runtime.ts:692-695`

The lock does not enforce that. `SessionLockManager.acquireLock` refuses only a **different** client: `else if (existing.clientId !== clientId) return false;` (`apps/server/src/services/session/session-lock.ts:83-89`). A same-client second turn re-acquires and runs concurrently. The lock file's own token doc names the exact case that does it: "a compose-next auto-flush starting a second detached turn before the first settles" (`session-lock.ts:38-45`). That is DOR-1088.

### 2.2 The fragility classes this shape produces

| #   | Class                                      | Where it lives                                                                                                                                                                                                                                          | What it costs                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `resumeSessionAt` anchor hack              | `message-sender.ts:505-531` sets the anchor; `:276-279` `isAnchorNotFound`; `:963-973` the drop-anchor retry                                                                                                                                            | 27 lines of comment explaining that without the anchor the CLI's resume classifier reads a trailing Stop-hook attachment as an interrupted turn and injects a synthetic "Continue from where you left off." turn before the real prompt. A compacted transcript makes the anchor vanish and the CLI hard-fails.                                                                     |
| F2  | `isResumeFailure` retries                  | `message-sender.ts:244-249` (four substring patterns), `:257` (`MAX_RESUME_RETRIES = 1`), `:974-989` (restart-as-new recursion)                                                                                                                         | Recovery by string-matching an error message. On a match the session silently restarts as brand new, losing history. One shared retry budget for two distinct failures, so spending it on F1 leaves none for F2.                                                                                                                                                                    |
| F3  | The sdk-session rebind dance               | `message-sender.ts:894-911` (in-loop rebind, awaited before the event leaves the server), `:948-956` (catch-all rebind), `trigger-turn.ts:336-342` + `:430-434` (the retried `tryRekey` and the best-effort 202)                                        | A brand-new session gets a canonical id mid-first-turn. Every consumer (projector registry, settings row, lock, client URL) has to be moved while the turn streams. Two production incidents are named in the comments: DOR-493 and DOR-838.                                                                                                                                        |
| F4  | Concurrent-stream seam (**DOR-1088**)      | `agent-types.ts:65-71` (single `activeQuery`, single `eventQueue`, single `eventQueueNotify`); `message-sender.ts:343` (`session.eventQueue = []` at turn start); `message-sender.ts:806-827` (the race loop that registers `session.eventQueueNotify`) | A second concurrent turn on the same session wipes the first turn's queued out-of-band events, steals the notify callback, overwrites `session.activeQuery`, and then the FIRST turn's `finally` clears `activeQuery` out from under the still-running second turn, killing its interrupt path. Same-client concurrency is reachable today (§2.1).                                  |
| F5  | Premature `turn_end` on multi-result turns | `sdk/event-mappers/result-event-mapper.ts:223-229` emits `done` for **every** `result`; `session/session-event-normalizer.ts:632-647` calls `closeTurn()` on **every** `done` with no already-ended guard                                               | Today one query produces one `result`, so this never fires. The moment the stream stays open and accepts a second message, the CLI produces a second `result`, and the durable stream emits two `turn_end`s for one logical turn. This is a latent blocker that the persistent design trips on day one.                                                                             |
| F6  | Phantom cancellation (**DOR-1087**)        | Reproduced and characterized on `worktree-dor-1087-phantom-stop` (uncommitted): `messaging/phantom-cancellation.ts`                                                                                                                                     | The CLI treats any message queued mid-turn as a user interruption. A background `<task-notification>` sitting in the CLI's internal queue when the model issues a permission-gated tool call makes the CLI cancel the call and write its interrupt sentinel as the tool_result. The model reads a human stop. Observed 2026-08-09: eight phantoms in one session, zero real denies. |

Two further consequences of the per-turn subprocess, both measured in comments rather than benchmarks (**unverified numerically**):

- **Cold cost every turn.** Subprocess spawn, MCP server connection, plugin activation, and prompt cache all restart per turn. `mcpServers` are deliberately re-created per query to dodge "Already connected to a transport" (`message-sender.ts:604-608`).
- **Init-time snapshots go stale.** `supportedCommands()` is captured once at session init and never reflects mid-session change, which is why plugin reload needs a second live propagation path (`claude-code-runtime.ts:439-448`).

### 2.3 What the person actually experiences

- Type while the agent works, and the message is held in the browser (`apps/client/src/layers/features/chat/model/use-message-queue.ts`), flushed on the streaming→idle edge, annotated server-side as a `queue_note` (`packages/shared/src/additional-context.ts:479`). It is lost on refresh and invisible to a second window.
- A second client mid-turn gets `409 SESSION_LOCKED`. The route test that pins this says out loud that the DOR-82 dispositions are meant to replace it: "DOR-82 will replace this incidental semantics with explicit queue/steer/interrupt dispositions" (`apps/server/src/routes/__tests__/sessions-cross-client.test.ts:26-27`).
- There is no way to say "also do X" without either waiting or stopping the agent. Steering exists in Codex (`turn/steer`) and Amp (`{steer:true}`) and is the single most-cited missing verb in the DOR-82 survey (§4.1-4.3 of the research report).

---

## 3) Goals and non-goals

**Goals.**

- G1. One persistent SDK query per ACTIVE claude-code session; the subprocess, its MCP connections, and its prompt cache stay warm across turns.
- G2. Three dispositions on the `AgentRuntime` boundary (`queue`, `steer`, `interrupt`) plus an optional fourth (`stage`), each with a declared capability and an honest server-side fallback.
- G3. The server owns the queue: durable across a client refresh, visible to every window, surfaced on the session snapshot and the durable stream.
- G4. Retire F1, F2 and F3 from the **hot path** (they survive only on the cold-start / recovery path), and close F4, F5 and F6 outright.
- G5. Every runtime passes an extended `runtimeConformance` covering the disposition contract, so a runtime that cannot steer says so instead of pretending.
- G6. No regression in the presence/durability contracts that ADR-0263/0264/0310 already hold runtimes to.

**Non-goals.**

- N1. Not making the persistent process survive a DorkOS restart. ADR-0264 already accepts in-flight turn loss on restart; the persistent query inherits that boundary and recovers via the resume path.
- N2. Not deleting `resume`. It is the fallback (constraint 2).
- N3. Not exposing `priority: 'now'` as a product feature until its scheduling is measured (see §11 D3). The SDK's own type still carries no prose for it at `0.3.224` (`sdk.d.ts:4757`), which is exactly the low-confidence flag the DOR-82 research raised eight weeks ago and nobody has since closed.
- N4. Not changing how codex or opencode run their turns.

---

## 4) The disposition contract

### 4.1 Shape: one envelope field, plus a separate interrupt verb

DOR-82 left this open (its §7 Q1). Recommendation: **`sendMessage` grows a disposition on `MessageOpts`; `interrupt` stays its own method.** Rationale:

- `interrupt` is not a message. It carries no content, it can be issued with nothing to send after it, and it already has a route (`POST /api/sessions/:id/interrupt`, `apps/server/src/routes/sessions.ts:924-937`) and an interface method (`agent-runtime.ts:794`). Folding it into `sendMessage` would mean inventing a contentless message.
- `queue` / `steer` / `stage` all _are_ messages that differ only in when and how they reach the model. That is an envelope field, exactly as Amp models it (`{steer: true}`).

```ts
/** How a message should reach a session that is already running a turn. */
export type MessageDisposition =
  /** Default. Run after the current turn ends. Never disturbs in-flight work. */
  | 'queue'
  /** Inject into the LIVE turn so the agent course-corrects without restarting. */
  | 'steer'
  /** Append to the transcript WITHOUT starting a turn; merges into the next one. */
  | 'stage';

export interface MessageOpts extends SessionSettings {
  // ...existing fields...
  /**
   * How this message reaches a session mid-turn. Ignored when the session is
   * idle (every disposition then means "run it now"). Defaults to 'queue'.
   * A runtime that cannot honor the requested disposition MUST degrade per
   * the fallback ladder rather than fail, and MUST report what it actually
   * did on the durable stream.
   */
  disposition?: MessageDisposition;
}
```

`interruptQuery` should be widened to return a typed receipt rather than a bare boolean, but that widening is **owned by spec `runtime-interrupt-receipts`** (`260807-231651`), which already designs `{ stopped, queuedDropped }` on top of SDK `interrupt_receipt_v1` / `cancel_queued` (`sdk.d.ts:2346`, `:3620`, `:4613`). This spec consumes that shape; it must not redefine it. See §11 D7 for the sequencing.

### 4.2 Capability flags

Three new booleans on `RuntimeCapabilities` (`packages/shared/src/agent-runtime.ts:461-560`), following the `supportsManagedMcpServers` precedent of being separate flags rather than a bag:

| Flag                        | Means                                                                                        | Not the same as                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `supportsPersistentSession` | The runtime keeps a warm process across turns and can accept input into it between turns     | Anything about mid-turn behavior                                                               |
| `supportsSteer`             | The runtime can deliver a message into a turn that is **already running**, without ending it | `supportsPersistentSession`: opencode is neither, codex could be the latter without the former |
| `supportsContextStaging`    | The runtime can append to the conversation without provoking a turn (`shouldQuery: false`)   | `supportsSteer`: staging does not reach a live turn                                            |

Queue needs no flag. The server always owns the queue, so every runtime supports it by construction. That is the whole point of the ADR-0264 seam, and it is why the queue is the fallback for everything else.

### 4.3 Per-runtime mapping and the fallback ladder

**The ladder (server-side, uniform):** `steer` → if unsupported, downgrade to `queue`. `stage` → if unsupported, hold the text and fold it into the next dispatched message as an `additionalContext` entry (the `queue_note` mechanism at `packages/shared/src/additional-context.ts:479` is the existing precedent for exactly this). `queue` → always available. **Every downgrade emits a `queue_update` event naming what was asked for and what happened**, so the cockpit can say "queued instead of steered, Codex cannot steer mid-turn" rather than silently doing something else. Honest degradation, ADR-0310 style.

| Runtime         | `queue`                                                        | `steer`                                                                                                                                                                                                                                                                                                                                             | `stage`                                        | Notes (verified)                              |
| --------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| **claude-code** | server queue; dispatched into the live query via `streamInput` | native: `streamInput` into the open stream (`sdk.d.ts:2610`)                                                                                                                                                                                                                                                                                        | native: `shouldQuery: false` (`sdk.d.ts:4764`) | The only runtime that gets all three natively |
| **codex**       | server queue                                                   | **investigate.** The DOR-82 survey found `turn/steer` on the Codex app-server, but the shipped DorkOS adapter uses the SDK's thread API whose only interrupt primitive is an `AbortSignal` (`codex-runtime.ts:722-737`, `codex/NOTES.md:145-161`). **Unverified** whether `@openai/codex-sdk` exposes steer at all. Declare `false` until measured. | fallback                                       | ADR-0309: fresh subprocess per turn           |
| **opencode**    | server queue                                                   | `false`. Interrupt is `POST /session/{id}/abort` (`opencode-runtime.ts:576-597`); the DOR-82 survey found the queue lives in OpenCode's own TUI, not its server                                                                                                                                                                                     | fallback                                       | ADR-0308 sidecar                              |
| **test-mode**   | server queue                                                   | `true` (deterministic fixture)                                                                                                                                                                                                                                                                                                                      | `true`                                         | Exists to exercise the contract               |

### 4.4 What the queue itself needs

DOR-82's §7 Q8 flagged that the session snapshot has no queue field at all. It still does not. The queue must become part of the ADR-0263 contract:

- `SessionSnapshot` gains `queuedMessages: QueuedMessage[]` (id, content, disposition, enqueuedAt, enqueuedBy clientId).
- A new `queue_update` `SessionEvent` member carrying the whole queue (small, bounded, and a full replacement avoids every ordering bug an incremental diff would invite). **Reminder for EXECUTE:** every new `SessionEvent` member must join the client's allowlist or it is dropped silently.
- Queue mutations (enqueue, remove, reorder, edit) get routes. The cockpit's existing queue affordances (`use-message-queue.ts:13-31`, including the `restore` handle that exists because DOR-480 destroyed a person's typed words on a refused trigger) map onto them one for one.

---

## 5) Persistent session lifecycle

### 5.1 States

```
                    first message
      ┌────────┐   (or explicit warm)   ┌────────┐
      │  COLD  │ ─────────────────────► │ WARMING│
      └────────┘                        └────────┘
           ▲                                 │ system/init received
           │                                 ▼
           │  idle timeout / evict      ┌────────┐  turn ends, queue empty
   ┌───────┴────────┐  ◄─────────────── │  WARM  │ ◄──────────────┐
   │   REAPED       │                   └────────┘                │
   └────────────────┘                        │ dispatch           │
           ▲                                 ▼                    │
           │                            ┌─────────┐               │
           │       process death        │ RUNNING │ ──────────────┘
           │      ┌──────────────────── └─────────┘
           │      ▼
      ┌──────────────┐   next dispatch    ┌──────────┐
      │   CRASHED    │ ─────────────────► │ RESUMING │ ──► WARMING
      └──────────────┘                    └──────────┘
```

| State    | Invariant                                                                        | `activeQuery`                       | Holds the write lock?        |
| -------- | -------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------- |
| COLD     | No subprocess. Session row may exist on disk.                                    | absent                              | no                           |
| WARMING  | `query()` called, `system/init` not yet seen. No turn is open.                   | present, not yet usable for control | no                           |
| WARM     | Subprocess alive, stdin held open, no turn open. Control methods answerable.     | present                             | **no**                       |
| RUNNING  | A turn is open: `turn_start` ingested, `turn_end` not yet.                       | present                             | yes, for the turn's duration |
| CRASHED  | Subprocess exited or the generator threw outside a turn.                         | cleared                             | no                           |
| REAPED   | Deliberately closed after idle. Indistinguishable from COLD except in telemetry. | cleared                             | no                           |
| RESUMING | Recovery: a fresh `query()` with `resume` set, exactly today's path.             | —                                   | —                            |

**The load-bearing change is that WARM is a real state.** Today there is no such thing: the subprocess exists only inside a turn's `try/finally` and is closed at `message-sender.ts:1017-1020`. Making it a state is what buys warm cache, mid-turn steering, and context staging. It is also what creates every new failure mode in §7.

### 5.2 Reap policy

Two distinct timers, and conflating them is a trap:

| Timer                          | Governs                                                                                                                                                                                                                           | Today                        | Proposal                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Process idle timeout** (new) | WARM → REAPED. How long a live subprocess sits with no turn.                                                                                                                                                                      | n/a (process dies each turn) | Start at **5 minutes**, configurable. Long enough that a person thinking between turns keeps their cache; short enough that 50 abandoned sessions do not hold 50 subprocesses. |
| **Session eviction**           | The in-memory `AgentSession` record. `SESSIONS.TIMEOUT_MS = 30 * 60 * 1000` (`constants.ts:113`), swept every `INTERVALS.HEALTH_CHECK_MS = 5 * 60 * 1000` (`constants.ts:5`) by `checkSessionHealth` (`session-store.ts:540-560`) | 30 min                       | Unchanged. Eviction implies reap, never the reverse.                                                                                                                           |

Reaping is invisible: the next message resumes. That is what makes the process-idle timer safe to set aggressively.

A reap **must not** happen while a pending interaction is open. `SESSIONS.INTERACTION_TIMEOUT_MS = 10 * 60 * 1000` (`constants.ts:117`) is longer than the proposed 5-minute idle window, and a reaped process cannot answer an approval the person is still looking at. See §7 FM3.

### 5.3 Resource ceiling

`MAX_SESSIONS = 50` (`constants.ts:119`) enforced at `session-store.ts:211-216`. With one subprocess per WARM session, 50 becomes 50 concurrent CLI processes and their MCP children. Two mitigations, both cheap:

- Reaping is per-session and already bounds this in practice.
- Add a separate, lower **warm ceiling** (default 10 to 15): the process pool is LRU-reaped down to the ceiling regardless of the idle timer. Session records stay at 50; only warmth is rationed. This keeps `ensureSession`'s existing throw as a genuinely exceptional path rather than something a busy operator hits.

---

## 6) Turn boundaries on a long-lived query

This is the hardest part of the design and the place where a naive implementation breaks ADR-0264.

### 6.1 The mismatch

Today the mapping is trivial because the units coincide: one `sendMessage` call = one `query()` = one `result` = one `done` = one `turn_end`. Verified at `sdk-event-mapper.ts:43-46` → `result-event-mapper.ts:223-229` → `session-event-normalizer.ts:636-640`.

With a persistent query, one `query()` spans **many** `result` messages, and the CLI can start continuations DorkOS never asked for (auto-resume continuations are explicitly named in the SDK's own docs at `sdk.d.ts:3628`). The three units come apart.

### 6.2 The rule

**A DorkOS turn opens on dispatch and closes on the `result` that answers it.** Concretely:

1. `feedProjector`'s `closeTurn()` becomes idempotent: guard on `ended` (`session-event-normalizer.ts:623-647`). This alone kills F5 and is the smallest correct change. It should land **first and independently**, because it is a latent bug regardless of anything else here.
2. `executeSdkQuery` stops being "the turn". It becomes a long-lived **pump** owned by the session, and a turn becomes a _window_ over that pump's output. Each dispatched message opens a window; the window closes on the correlated `result`.
3. **Correlation is by uuid.** `SDKUserMessage` carries an optional `uuid` (`sdk.d.ts` `SDKUserMessage`), and the CLI's queue reasons in exactly those terms: `still_queued` and `cancelled` are uuid lists (`sdk.d.ts:3628`, `:3632`). DorkOS stamps every dispatched message with its own uuid and correlates the `result` back to it. Do **not** correlate positionally: the SDK's own docs say a dequeued batch is coalesced into one turn, so several dispatched uuids can share one `result`, and text matching was already rejected once for exactly this class of ambiguity (`trigger-turn.ts:229-243`).
4. **A steer does not open a turn.** It joins the open window. Its content rides the existing `turn_start.userMessage`... which does not have a slot for a second message. Recommendation: a new `turn_input` `SessionEvent` carrying `{ content, disposition: 'steer' }`, ingested into the open turn. The cockpit renders it inline as a user message inside the running turn, which is what the person did.
5. **A `stage` message opens no turn at all.** It emits a `context_staged` event so the transcript is honest, and merges into the next dispatch per the SDK's documented `shouldQuery: false` semantics (`sdk.d.ts:4764`).
6. **CLI-internal continuations** (a `result` with no correlated uuid) must not be silently dropped or silently rendered as a DorkOS turn. Recommendation: open a synthetic turn tagged with an origin of `runtime`, so the durable stream stays a complete account of the session. This is the same honesty rule the presence contract already enforces (`contributing/adding-a-runtime.md`, presence table).

### 6.3 What survives unchanged

- The ADR-0264 pipeline: `trigger-turn` → `feedProjector` → `SessionStateProjector` → `GET /:id/events` with snapshot / gap-free replay / live. Turn _identity_ changes; the transport does not.
- `guardTurnErrors`' error-terminal translation (`trigger-turn.ts:492-530`). A pump-level throw must still close the open window with `status_change(error)`, a typed `error`, and one `turn_end(error)`.
- The stall watchdog (`trigger-turn.ts:378-384`, `services/session/stall-guard.ts`). It measures inactivity **within a turn window** and must not fire on a WARM session that is legitimately silent. This needs an explicit guard: the watchdog arms on window open and disarms on window close.

---

## 7) Locking, serialization, and DOR-1088

### 7.1 The lock's job changes

The write lock exists to prevent two clients writing one conversation at once. With a server queue, the honest answer for a second writer is no longer 409; it is **accept and queue**. That is DOR-82's recommendation 5 and the route test's own stated future (`sessions-cross-client.test.ts:26-27`).

Recommendation: **keep the lock, retarget it.** It stops being "who may POST" and becomes "who may currently _dispatch_ into the query" — an internal dispatch mutex held for the length of one turn window, not an HTTP-visible gate. `POST /messages` then returns 202 with a queue position instead of 409. The lock's liveness machinery (`LockActivity`, `session-lock.ts:22-30`, DOR-782) carries over unchanged and is still what reclaims a dark turn.

### 7.2 DOR-1088 is a prerequisite, not a side effect

The single-flight guarantee the interface _claims_ (`agent-runtime.ts:692-695`) is the guarantee the persistent design _needs_, and it is false today (§2.1, §2.2 F4). Two options:

- **(a) Enforce it.** Make the lock reject same-client concurrent dispatch too, and route the second message into the queue.
- **(b) Support it.** Make the session's shared mutable state (`activeQuery`, `eventQueue`, `eventQueueNotify` at `agent-types.ts:65-71`) per-turn rather than per-session.

**Recommendation: (a).** A persistent query is a single input stream by construction, so genuinely parallel turns on one session are not expressible anyway. Option (b) buys nothing the queue does not already buy, and it multiplies the state the CLI's own queue is already reasoning about. Deliver (a) as DOR-1088 **before** the persistent pump lands, so the pump is built on a guarantee that is actually true.

Note the relay's `enqueueForSession` (`packages/relay/src/adapters/runtime-adapter.ts:173-187`, ADR-0075) already serializes per session for exactly this reason. It is the right shape and it is at the wrong layer: it protects relay-driven messages and knows nothing about cockpit-driven ones. The server queue subsumes it.

### 7.3 The other trigger paths

Every one of these calls `sendMessage` or `executeCommandIntent` and therefore contends: `routes/sessions.ts:695`, `routes/session-ui-action-handler.ts:100`, `routes/session-command-intent-handler.ts:149`, `services/rooms/room-turn-runner.ts:277`, `services/session/embedded-turn-trigger.ts:80` and `:148`, `services/tasks/run-stream.ts`, `services/mesh/mcp-signin-resume.ts:196`. `executeCommandIntent` for claude-code is literally `sendMessage('/compact')` (`claude-code-runtime.ts:422-430`), so it contends identically. **The queue must be the single ingress for all of them**, or one of them keeps the old race.

---

## 8) Failure modes

| #   | Failure                                                 | Today                                                                                            | With a persistent session                                                                                                                                                                                        | Required behavior                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FM1 | Process dies mid-turn                                   | One turn lost; next turn resumes. Blast radius is a turn.                                        | Blast radius is the **session**: warm cache, in-flight turn, and every queued message behind it                                                                                                                  | Detect exit, close the open window with `turn_end(terminalReason:'error')`, transition to CRASHED, **preserve the queue**, and RESUME on the next dispatch. The queue surviving a crash is the whole justification for it being server-owned.                                      |
| FM2 | Server restart                                          | ADR-0264 accepts in-flight turn loss; a `streaming` turn is marked `interrupted` on cold hydrate | Same, plus every warm process is orphaned                                                                                                                                                                        | Kill orphans in `shutdownServices()` (the opencode sidecar teardown is the model, `contributing/adding-a-runtime.md` step 7). Queue durability across restart: see §11 D5.                                                                                                         |
| FM3 | Idle reap while an approval is pending                  | Cannot happen: the subprocess is held open by the turn                                           | **Can** happen: the person walks away, the reaper fires, the approval is answered into a dead process                                                                                                            | Reap is forbidden while `projector.hasPendingInteractions()` is true. That probe already exists and is already shared by the lock and the stall watchdog (`trigger-turn.ts:291`). Reuse it; do not invent a third liveness notion.                                                 |
| FM4 | Queued message fires during a pending permission prompt | n/a                                                                                              | The classic bug, shipped by Gemini (#17719) and OpenCode (#2609) per the DOR-82 survey §4.3                                                                                                                      | Dispatch is gated on the same pending-interaction probe. Test it explicitly.                                                                                                                                                                                                       |
| FM5 | Queued messages dropped on interrupt                    | n/a                                                                                              | OpenCode #5333                                                                                                                                                                                                   | Interrupt semantics must be **declared**: does Stop mean "stop this turn" or "stop everything"? The SDK models both (`cancel_queued`, `sdk.d.ts:3620`). See §11 D4.                                                                                                                |
| FM6 | Premature dequeue                                       | n/a                                                                                              | OpenCode #15696                                                                                                                                                                                                  | Dequeue happens on `turn_end`, never on `result` alone (§6.2). Pinned by test.                                                                                                                                                                                                     |
| FM7 | Phantom cancellation (DOR-1087)                         | Live bug                                                                                         | **Should disappear**, because DorkOS stops racing the CLI's internal queue: with a persistent stream, DorkOS controls when messages enter it and can hold dispatch until the turn window closes. **Unverified.** | Do not assume. Keep the DOR-1087 detector (`phantom-cancellation.ts`) as a **regression tripwire** past the migration: if it ever fires on the persistent path, the design is wrong somewhere. Delete it only after a measured quiet period.                                       |
| FM8 | Reap races a dispatch                                   | n/a                                                                                              | The reaper decides to close while a message is being dispatched                                                                                                                                                  | Reap and dispatch share the dispatch mutex (§7.1). A reap that loses simply does not happen.                                                                                                                                                                                       |
| FM9 | Warm process holds a stale account / cwd / credential   | n/a                                                                                              | `accountRoot` is resolved per turn today (`message-sender.ts:450`, spec `claude-code-accounts` D3), as is the credential env (`:429`) and the agent identity token (`:437`)                                      | A warm process pins whatever it was launched with. Any change to account, cwd, model-that-requires-relaunch, or credential must **force a reap** and relaunch. Enumerate the full pin list in SPECIFY; getting it wrong bills a paying client's conversation to the wrong account. |

---

## 9) Migration and rollout

**Per-session opt-in, config-gated, defaulting off, promoted to on in a later release.** Not a global flag, not a hard cutover.

Why per-session rather than a global flag: the two paths must be able to run side by side on one host, because that is the only way to compare them on the same workload, and because the fallback path is not going away (constraint 2). The mechanism is a config field under `runtimes.claudeCode` (`packages/shared/src/config-schema.ts`) plus the semver-keyed migration the `adding-config-fields` skill requires.

Sequenced so each step is independently shippable and independently revertable:

| Step | Ships                                                                                                                                                          | Reverts by                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 0    | Idempotent `closeTurn` (F5). Pure bug fix, no flag.                                                                                                            | git revert                              |
| 1    | DOR-1088: single-flight enforced, second message queued.                                                                                                       | flag off → 409 as before                |
| 2    | Server-owned queue behind the trigger POST. Snapshot + `queue_update` + routes. Client queue reads the server's. Dispositions accepted, all mapped to `queue`. | flag off → client-side queue            |
| 3    | Persistent pump for claude-code, opt-in. Resume path becomes the fallback. Reaper, warm ceiling, pin list.                                                     | flag off → resume-per-message           |
| 4    | `steer` and `stage` wired natively for claude-code; capability flags for all four runtimes; conformance extended.                                              | capability flag false → fallback ladder |
| 5    | Default flipped on; DOR-1087 tripwire watched; phantom detector removed after a quiet period.                                                                  | flag off                                |

**The comparison that decides step 5** must be measured, not asserted: time-to-first-token per turn, cache-read token ratio, resident subprocess count, phantom-cancellation rate. Ideation deliberately makes no performance claim; the numbers in §2.2 are marked unverified for that reason.

---

## 10) Conformance additions

Every one of these goes in `packages/test-utils/src/runtime-conformance.ts` (currently 1259 lines, `describe` blocks at `:581-1244`), because a capability that is not conformance-tested is a capability a runtime can lie about. The suite already proves this discipline works: `validatePresenceReport` exists precisely so a runtime cannot fabricate presence.

New `RuntimeConformanceOpts` and cases:

1. **Disposition honesty.** For each of `steer` / `stage`: if the capability is declared, a mid-turn message must reach the model without a new `turn_start`; if it is not declared, the same call must degrade to `queue` and emit the downgrade notice. Neither may throw.
2. **Terminal exactly once.** A turn window emits exactly one `turn_end`, no matter how many native `result`s the backend produced. This is the F5 guard, and it must be provable by **seeding the defect** (drop the idempotence guard, watch it go red).
3. **Queue durability.** A message queued behind a turn that then fails must still run (FM1) and must not run during a pending interaction (FM4).
4. **Persistence honesty.** A runtime declaring `supportsPersistentSession` must report `idle` (not `streaming`) while WARM. The existing presence table already forbids `streaming` with an empty `inProgressTurn`; WARM is a new way to get that wrong.
5. **Reap safety.** Driving a session to WARM, reaping it, and sending again must produce a well-formed turn. The person cannot tell.

Cases 1 and 4 need a driver in the mould of `presenceTurn` / `drivePresenceTurn`, for the same stated reason: a `sendMessage` generator alone moves no projector and would assert nothing. Omitted driver = a named skip, never a silent pass.

---

## 11) Open decisions, with recommended answers

| #       | Decision                                                                     | Options                                                                                                                                      | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                              | Confidence                                                                           |
| ------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **D1**  | Interface shape for dispositions                                             | (a) `sendMessage(..., { disposition })` + separate `interrupt`; (b) explicit verbs `enqueueMessage` / `steer(turnId, content)` / `interrupt` | **(a)**, per §4.1. Fewer methods for a new runtime author to implement, and it matches Amp's portable `{steer: true}` envelope. Codex's `expectedTurnId` requirement is served by the correlation uuid, adapter-internal.                                                                                                                                                                                                                                   | High                                                                                 |
| **D2**  | Default disposition for a mid-turn message                                   | queue / steer / ask the person per message                                                                                                   | **`queue`**, matching the SDK default and every surveyed TUI (DOR-82 §4.1). Steer is opt-in via a composer affordance. Calm by default; the person opts into disruption.                                                                                                                                                                                                                                                                                    | High                                                                                 |
| **D3**  | Use SDK `priority: 'now' \| 'next' \| 'later'`?                              | Adopt / ignore / measure first                                                                                                               | **Measure first, do not ship on it.** The field still has no prose doc at `0.3.224` (`sdk.d.ts:4757`). DOR-82 §3.2 flagged this as low confidence and it is still open. Ship `steer` on `streamInput`, whose behavior IS documented (`sdk.d.ts:2610`). Revisit `priority: 'now'` only with an empirical result.                                                                                                                                             | High                                                                                 |
| **D4**  | Does Stop mean "stop this turn" or "stop everything queued"?                 | Turn-only / everything / a person-facing choice                                                                                              | **Everything, by default.** The SDK's own doc says a remote UI's Stop button is the `cancel_queued: true` case (`sdk.d.ts:3620`). A person who presses Stop with three messages queued and watches the next one fire has been lied to. Surface the count in the confirmation ("Stop, and drop 3 queued messages?").                                                                                                                                         | Medium: needs the receipt work (D7) to report honestly                               |
| **D5**  | Does the queue survive a server restart?                                     | In-memory / persist to SQLite `session_metadata`-adjacent table                                                                              | **Persist.** The queue is the person's typed words. ADR-0264 accepts losing an in-flight _turn_ on restart; losing a message somebody typed and was told was accepted is a different and worse promise to break. DOR-480 already established that this class of loss is unacceptable (`use-message-queue.ts:13-31`).                                                                                                                                        | Medium: adds a migration; could slip to a follow-up if it threatens the phase-2 ship |
| **D6**  | Warm process ceiling                                                         | None / equal to `MAX_SESSIONS` (50) / a separate lower number                                                                                | **Separate, default 10 to 15, configurable.** 50 concurrent CLI subprocesses plus their MCP children on a laptop is not a shape to ship untested; and warmth is a cache, so LRU eviction is exactly right for it.                                                                                                                                                                                                                                           | Medium: the number wants one measurement                                             |
| **D7**  | Relationship to `runtime-interrupt-receipts` and `runtime-prompt-redelivery` | Absorb them / depend on them / ignore                                                                                                        | **Depend, and sequence.** `runtime-interrupt-receipts` (`260807-231651`) owns the typed interrupt result and `cancel_queued`; this spec consumes it and must not redefine it. `runtime-prompt-redelivery` (`260807-231653`) owns `reinitialize()` (`sdk.d.ts:2452`), which becomes **more** valuable here (a warm process that survives a client gap is exactly what it recovers). Land interrupt-receipts alongside phase 4; prompt-redelivery can follow. | High                                                                                 |
| **D8**  | What happens to the client-side queue (ADR-0104)                             | Keep both / replace / keep as offline buffer                                                                                                 | **Replace, preserving the UX.** Two queues means two sources of truth and a reconciliation bug waiting to happen. ADR-0104 gets superseded by the ADR this spec produces.                                                                                                                                                                                                                                                                                   | High                                                                                 |
| **D9**  | Does `stage` ship in this programme or later?                                | Now / later                                                                                                                                  | **Now, but last** (phase 4, behind `supportsContextStaging`). It is the cheapest of the three natively (one boolean on the message) and it is the one that answers the original operator question, "can I pass information in without stopping the run?" Cutting it would leave the contract two-thirds done.                                                                                                                                               | Medium                                                                               |
| **D10** | Do phantom-cancellation defences (DOR-1087) get deleted after migration?     | Delete on cutover / keep as tripwire / keep forever                                                                                          | **Keep as a tripwire through phase 5, then delete.** The hypothesis that persistence removes the phantom class is untested (FM7). A detector that never fires is cheap; a silently returned phantom is expensive. Deleting it is a scheduled task, not an assumption.                                                                                                                                                                                       | High                                                                                 |

---

## 12) Phase plan into SPECIFY and DECOMPOSE

**SPECIFY produces:** the disposition contract as concrete TypeScript on `AgentRuntime` and `RuntimeCapabilities`; the queue's persisted schema and its `SessionSnapshot` / `SessionEvent` additions; the state machine as an implementable table with every transition's trigger and guard; the complete relaunch-pin list (FM9); the conformance case list with its drivers; and the config field plus its semver-keyed migration.

**Draft ADRs SPECIFY should seed (per `writing-adrs`):**

- **ADR-a: Three dispositions at the `AgentRuntime` boundary.** Supersedes nothing; extends the ADR-0263 vocabulary.
- **ADR-b: Persistent streaming-input sessions for claude-code, with resume as the recovery path.** Records the WARM state and the reap policy.
- **ADR-c: Server-owned durable message queue.** **Supersedes ADR-0104** (client-side queue with auto-flush). Amends ADR-0264 by naming the queue as the thing that sits behind the trigger-only POST, which ADR-0264's own context anticipated.

**Phases for DECOMPOSE**, matching the rollout table in §9 so each phase is a shippable, revertable slice:

| Phase  | Scope                                            | Rough shape                                                                                                                                                                         | Gates on |
| ------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **P0** | Idempotent `closeTurn` (F5)                      | 1 task, tiny, no flag                                                                                                                                                               | nothing  |
| **P1** | DOR-1088 single-flight                           | 2 to 3 tasks: lock semantics, all-ingress audit (§7.3), tests                                                                                                                       | P0       |
| **P2** | Server-owned queue                               | 6 to 8 tasks: schema + persistence (D5), snapshot/event contract, routes, client cutover, `queue_note` continuity, ADR-0104 supersession                                            | P1       |
| **P3** | Persistent pump, opt-in                          | 8 to 10 tasks: pump lifecycle, turn windowing + uuid correlation, reaper + warm ceiling, pin list, crash/resume, stall-guard rearm, config + migration                              | P2       |
| **P4** | Dispositions native + capabilities + conformance | 6 to 8 tasks: `steer` via `streamInput`, `stage` via `shouldQuery`, four runtimes' flags, fallback ladder + downgrade notice, conformance suite, interrupt-receipt integration (D7) | P3       |
| **P5** | Default on, measure, clean up                    | 3 to 4 tasks: measurement pass, flip, DOR-1087 tripwire watch, detector removal (D10)                                                                                               | P4       |

P0 and P1 are worth dispatching immediately: both are correctness fixes that stand on their own merits whether or not the rest of the programme proceeds.

---

## 13) Pre-reading log

| Read                                                                                                | Takeaway                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `research/20260610_message_queuing_agent_runtimes.md`                                               | The foundation. Four-pattern taxonomy, cross-runtime matrix, the recommendation this programme executes. Its §7 open questions map to §11 here, and Q1/Q2/Q4/Q5/Q8 are answered.                           |
| `apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts`                         | The whole current turn pipeline, all 1062 lines of it. Sources for F1, F2, F3, F4, and the held-prompt design.                                                                                             |
| `apps/server/src/services/runtimes/claude-code/sdk/sdk-utils.ts`                                    | `createHeldPrompt` (`:73-98`) is the seam the persistent pump grows out of. The DOR-1087 branch has already converted it to a queue-driven generator with `push()`, which is very close to what §6 needs.  |
| `packages/shared/src/agent-runtime.ts`                                                              | The interface to extend. Its `sendMessage` single-flight claim (`:692-695`) is false today, which is DOR-1088.                                                                                             |
| `decisions/0264-server-owned-durable-resumable-session-stream.md`                                   | Trigger-only POST, projector, snapshot → replay → live. The seam the queue belongs behind, and the restart loss boundary the persistent design inherits.                                                   |
| `decisions/0075-promise-chain-queue-for-cca-concurrency.md`                                         | Per-session promise chain, now generalized to `enqueueForSession`. Right shape, wrong layer: it protects relay traffic only.                                                                               |
| `contributing/adding-a-runtime.md`                                                                  | What a new capability costs a runtime author: capability flag, conformance case, honest degradation. The presence-truthfulness section is the model for how the disposition flags should be policed.       |
| `packages/test-utils/src/runtime-conformance.ts`                                                    | 1259 lines; `RuntimeConformanceOpts` at `:44-131`. The driver pattern (`presenceTurn`, `durableHistory`) is what the new cases need.                                                                       |
| `apps/server/src/services/session/{trigger-turn,session-lock,session-event-normalizer}.ts`          | Lock lifetime, canonical-id race, stall guard, and the `closeTurn` that fires on every `done`.                                                                                                             |
| `sdk.d.ts` @ `0.3.224`                                                                              | `streamInput` `:2610`, `interrupt` receipt `:2346`, `reinitialize` `:2452`, `priority` `:4757` (still undocumented), `shouldQuery` `:4764`, `cancel_queued` `:3620`, capability feature-detection `:4613`. |
| `specs/runtime-interrupt-receipts/01-ideation.md`, `specs/runtime-prompt-redelivery/01-ideation.md` | Adjacent, already-ideated. Boundaries drawn in D7.                                                                                                                                                         |
| `worktree-dor-1087-phantom-stop` (uncommitted)                                                      | The live phantom-cancellation characterization: the CLI's interrupt sentinel, verbatim, and why DorkOS can tell a phantom from a real deny.                                                                |
