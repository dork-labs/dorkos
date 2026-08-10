# Persistent session runtime, and the queue / steer / interrupt contract

**Status:** Approved (frozen for DECOMPOSE)
**Work item:** DOR-1089 · **Slug:** `persistent-session-runtime` · **Id:** `260810-003853`
**Date:** 2026-08-09
**Input:** [`01-ideation.md`](01-ideation.md) (all ten open decisions resolved; see §3)

---

## Overview

Move the claude-code runtime off resume-per-message onto a **persistent streaming-input session**: one long-lived SDK `query()` per active session, with an idle timeout that closes the process, and today's `resume` path demoted to the crash / restart / cold-start fallback.

On top of that, standardize how a message reaches a session that is already busy. Three dispositions become first-class at the server ingress: **queue** (default, run after the current turn), **steer** (inject into the live turn), **stage** (append to the transcript without provoking a turn). Interrupt stays a separate verb. Each disposition carries a capability flag, and a runtime that cannot honor one degrades down a uniform ladder and says so out loud rather than silently doing something else.

The server owns the queue. That is the load-bearing architectural commitment: it is what makes a queued message survive a refresh, a second window, a crashed turn, and a server restart, and it is what lets three runtimes with three different process models present one honest contract.

---

## Background / Problem Statement

The full evidence trace is in [`01-ideation.md` §2](01-ideation.md), with `file:line` pointers verified at `e4b9e1a9b`. The short form:

**The current shape.** `executeSdkQuery` builds a fresh SDK query per turn (`message-sender.ts:690-692`), resumes the prior SDK session with an anchor (`:505-531`), holds stdin open only long enough to answer control requests inside that turn (`sdk-utils.ts:73-98`), and closes the process on the first `result` (`message-sender.ts:845-864`). Resume-per-message plus held-stream-within-turn.

**What that costs.** Six fragility classes, four of them live:

| Class                                                                                                                    | Status                                                                      |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| F1 `resumeSessionAt` anchor hack (`message-sender.ts:505-531`, `:276-279`, `:963-973`)                                   | live, hot path                                                              |
| F2 `isResumeFailure` retries by substring match (`message-sender.ts:244-249`, `:257`, `:974-989`)                        | live, hot path                                                              |
| F3 sdk-session rebind dance (`message-sender.ts:894-911`, `trigger-turn.ts:336-342`)                                     | live, cost two incidents (DOR-493, DOR-838)                                 |
| F4 concurrent-stream seam                                                                                                | **being closed now** as DOR-1088; see §4                                    |
| F5 premature `turn_end` on multi-result turns (`result-event-mapper.ts:223-229` + `session-event-normalizer.ts:632-647`) | latent; fires on day one of a persistent stream                             |
| F6 phantom cancellation (DOR-1087)                                                                                       | live; eight phantoms in one session, zero real denies (observed 2026-08-09) |

**What the person experiences.** Type while the agent works and the words sit in the browser, lost on refresh, invisible to a second window (`use-message-queue.ts`). A second client mid-turn gets `409 SESSION_LOCKED`, and the route test that pins that behavior already names its replacement: "DOR-82 will replace this incidental semantics with explicit queue/steer/interrupt dispositions" (`apps/server/src/routes/__tests__/sessions-cross-client.test.ts:26-27`). There is no way at all to say "also do X" without waiting or stopping.

---

## Goals

- **G1.** One persistent SDK query per ACTIVE claude-code session; subprocess, MCP connections, and prompt cache stay warm across turns.
- **G2.** `queue` / `steer` / `stage` expressed once at the server ingress, resolved into runtime primitives behind declared capability flags, with a uniform degradation ladder and a visible downgrade notice.
- **G3.** A server-owned queue that survives client refresh, multi-window, turn failure, and server restart.
- **G4.** F1, F2, F3 confined to the cold-start / recovery path; F5 and F6 closed outright. (F4 closes as DOR-1088, a prerequisite.)
- **G5.** Every runtime passes an extended `runtimeConformance` covering dispositions, warmth honesty, and terminal-exactly-once.
- **G6.** No regression against the ADR-0263 / 0264 / 0310 contracts: snapshot to gap-free replay to live, presence truthfulness, per-runtime degradation.

## Non-Goals

- **N1.** The persistent process does **not** survive a DorkOS restart. ADR-0264 already accepts in-flight turn loss on restart; the pump inherits that boundary and recovers through resume.
- **N2.** `resume` is not deleted. It is the recovery route.
- **N3.** No reliance on the SDK's `priority` field (D3).
- **N4.** Codex and OpenCode do not become persistent. They gain vocabulary and honest flags only.
- **N5.** No horizontal scaling / cross-process session affinity.
- **N6.** No composer redesign. This changes what the composer can ask for, not how it looks.

---

## Technical Dependencies

| Dependency                                          | Version                                           | Why                                                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@anthropic-ai/claude-agent-sdk`                    | `0.3.224` (pinned, `apps/server/package.json:26`) | `streamInput` (`sdk.d.ts:2610`), `shouldQuery` (`:4764`), interrupt receipt (`:2346`), `cancel_queued` (`:3620`), `reinitialize` (`:2452`), capability feature-detection (`:4613`) |
| **DOR-1088** (`worktree-dor-1088-stream-serialize`) | in flight                                         | **Hard prerequisite.** See §4                                                                                                                                                      |
| `runtime-interrupt-receipts` (spec `260807-231651`) | not started                                       | Owns the typed interrupt result and `cancel_queued`. This spec consumes it (D7)                                                                                                    |
| `runtime-prompt-redelivery` (spec `260807-231653`)  | not started                                       | Owns `reinitialize()`. Composes with warm sessions; not a blocker                                                                                                                  |

Capability detection is by **feature flag from `system/init`, never by version sniffing**, per the SDK's own instruction at `sdk.d.ts:4613`. A CLI that does not advertise `interrupt_cancel_queued_v1` gets the documented older behavior and the client is told so.

---

## Detailed Design

### 1. What DOR-1088 lands, and what this spec builds on top of it

DOR-1088 is being implemented right now on `worktree-dor-1088-stream-serialize`. This spec assumes it lands first. Its shape, read from that branch:

- **`apps/server/src/services/session/turn-queue.ts` (new).** `SessionTurnQueue.reserve(sessionId, clientId)` returns a `TurnSlot { ready: Promise<void>; release(): void }`. A per-`(session, client)` promise chain, the same shape as `RuntimeAdapter.enqueueForSession` (ADR-0075). Registration is synchronous, so two triggers in one tick are ordered by arrival.
- **`trigger-turn.ts`.** Reserves the slot before anything else and awaits `slot.ready`; releases it in `releaseOnce` and on the launch-throw path. The 202 now resolves only once the queued turn actually **starts**, so the trigger POST is held open for as long as the turn ahead of it runs.
- **`session-lock.ts`.** `acquireLock` refuses **any** live lock, including the same client's. The same-client re-acquire that let one browser tab start a second turn beside its own is gone. Expired locks are still reclaimable, so a crashed holder still frees its session.
- **`message-sender.ts`.** The `finally` learns to clear `session.activeQuery` only when the frame still owns it, so a late-settling frame cannot strand its successor. _(In progress on that branch at time of writing: the comment has landed, the guard has not. Treat the guard as part of DOR-1088's definition of done, not as work for this spec.)_

**What DOR-1088 gives this spec:** the single-flight guarantee `AgentRuntime.sendMessage` has always claimed (`agent-runtime.ts:692-695`) and never had. The persistent pump is built on that guarantee being true.

**What DOR-1088 deliberately does not give:** a durable queue. Its chain is in-memory, per-client, invisible to other windows, lost on restart, and it holds an HTTP socket open per waiting message. **P2 of this spec upgrades it**: same ordering guarantee, but the queue becomes durable, cross-client, inspectable, mutable, and the 202 returns immediately with a queue position instead of holding the request. `SessionTurnQueue` then becomes an internal detail of the dispatcher rather than the thing an HTTP request waits on.

### 2. The disposition contract

#### 2.1 Where each piece lives

The approved D1 answer is "envelope plus a separate interrupt verb, not three new required runtime verbs". Implementing it revealed one refinement, recorded as `Q1 (RESOLVED)` in §Open Questions: **the envelope lives at the server ingress; at the `AgentRuntime` boundary it resolves into two shapes**, because a steer produces events belonging to a turn whose generator is already being consumed by another `feedProjector` call, and therefore cannot itself return a turn-shaped generator.

| Layer                                                                | Surface                                                                                                                     |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Ingress (`POST /messages`, room runner, tasks, embedded, relay, MCP) | one envelope field: `disposition`                                                                                           |
| Server queue + dispatcher                                            | resolves disposition against capability + live session state, applies the ladder, emits the outcome                         |
| `AgentRuntime`                                                       | `sendMessage` (unchanged signature, opens a turn) **plus** one new optional method `deliverIntoTurn` (does not open a turn) |

#### 2.2 Shared types (`packages/shared/src/agent-runtime.ts`)

```ts
/**
 * How a message should reach a session that is already running a turn.
 *
 * Ignored when the session is idle: every disposition then means "run it now".
 * Defaults to `'queue'` at every ingress (spec `persistent-session-runtime`, D2).
 */
export type MessageDisposition =
  /** Run after the current turn ends. Never disturbs in-flight work. */
  | 'queue'
  /** Inject into the LIVE turn so the agent course-corrects without restarting. */
  | 'steer'
  /** Append to the transcript WITHOUT provoking a turn; merges into the next one. */
  | 'stage';

/** Why the server applied a disposition other than the one asked for. */
export type DispositionDowngradeReason =
  /** The resolved runtime does not declare the requested capability. */
  | 'unsupported'
  /** Nothing was running, so the message simply ran. Not a degradation to apologise for. */
  | 'session-idle'
  /** The turn closed between acceptance and delivery. */
  | 'no-open-turn'
  /** The session is parked on an approval/question/elicitation; delivery would fire into it. */
  | 'pending-interaction';

/** What actually happened to a message the server accepted. */
export interface MessageDeliveryOutcome {
  /** Server-minted id. The queue, the durable stream, and the runtime all key on it. */
  messageId: string;
  /** What the caller asked for. */
  requested: MessageDisposition;
  /** What the server actually did. */
  applied: MessageDisposition;
  /** Present only when `applied !== requested`. */
  degradedBecause?: DispositionDowngradeReason;
}
```

`MessageOpts` gains two fields:

```ts
export interface MessageOpts extends SessionSettings {
  // ...existing fields unchanged...

  /**
   * How this message reaches a session mid-turn. Defaults to `'queue'`.
   * Resolved by the server BEFORE the runtime is called: by the time an adapter
   * sees `sendMessage`, the decision to open a turn has already been made.
   */
  disposition?: MessageDisposition;

  /**
   * Server-minted correlation id for this message.
   *
   * A persistent query spans many turns, so a `result` must be matched back to
   * the message that caused it. Correlation is by id and never positional: the
   * SDK coalesces a dequeued batch into one turn (`sdk.d.ts:3628`), so several
   * dispatched ids can share one `result`, and text matching was already
   * rejected for this exact ambiguity (`trigger-turn.ts:229-243`).
   */
  messageId?: string;
}
```

#### 2.3 The new optional runtime method

```ts
/** Non-turn-opening delivery modes. */
export type DeliverMode = 'steer' | 'stage';

/** Inputs for {@link AgentRuntime.deliverIntoTurn}. */
export interface DeliverIntoTurnOpts {
  /** `'steer'` reaches the live turn; `'stage'` reaches the transcript only. */
  mode: DeliverMode;
  /** The server-minted correlation id (see {@link MessageOpts.messageId}). */
  messageId: string;
  /** Neutral additional-context bag, assembled server-side exactly as for a turn (ADR-0273). */
  additionalContext?: AdditionalContext;
}

/** What a runtime did with a {@link AgentRuntime.deliverIntoTurn} call. */
export interface RuntimeDeliveryResult {
  /** True when the content reached the backend. */
  delivered: boolean;
  /** Why not. Present only when `delivered` is false. */
  reason?: 'no-open-turn' | 'stream-closed' | 'unsupported';
}
```

```ts
export interface AgentRuntime {
  // ...existing members unchanged...

  /**
   * Deliver a message into a session WITHOUT opening a turn.
   *
   * `'steer'` requires a turn to be open and injects into it; the resulting
   * events surface on that turn's already-running stream, which is why this
   * returns a receipt rather than a generator. `'stage'` requires no open turn
   * and provokes none.
   *
   * Called ONLY when the matching capability is declared
   * (`supportsSteer` / `supportsContextStaging`). Optional on the interface so a
   * runtime that can do neither simply does not implement it; the server's
   * degradation ladder covers the gap, so a missing implementation is never an
   * error the person sees.
   *
   * MUST NOT throw for an ordinary refusal. Report it as
   * `{ delivered: false, reason }` so the server can degrade rather than fail
   * the message.
   *
   * @param sessionId - Target session.
   * @param content - The user's text, pristine. Context rides `additionalContext`.
   * @param opts - Mode, correlation id, and the neutral context bag.
   */
  deliverIntoTurn?(
    sessionId: string,
    content: string,
    opts: DeliverIntoTurnOpts
  ): Promise<RuntimeDeliveryResult>;

  /**
   * Current process warmth for a runtime that keeps sessions warm.
   * Runtimes with no warm concept omit this entirely; the platform reads
   * `'cold'` for them and never asks them to reap.
   */
  getSessionWarmth?(sessionId: string): SessionWarmth;

  /**
   * Close a warm process without touching the session record or its transcript.
   * Idempotent, and a no-op when the session is not warm. Never called while the
   * session holds a pending interaction (spec §5, FM3).
   */
  reapSession?(sessionId: string): Promise<void>;
}
```

`interruptQuery`'s widening to a typed receipt is **owned by `runtime-interrupt-receipts`** (D7). This spec consumes whatever that spec lands and must not redefine it. Until it lands, `interruptQuery(): Promise<boolean>` stays as is and the client says "stop requested" rather than "stopped".

#### 2.4 Capability flags

Three new required booleans on `RuntimeCapabilities` (`agent-runtime.ts:461-560`). Required, not optional, following the `commandIntents` / `settings` precedent (ADR-0256): compile-time forcing so no adapter can silently omit one.

```ts
export interface RuntimeCapabilities {
  // ...existing members unchanged...

  /** The runtime keeps a warm process across turns and can accept input between them. */
  supportsPersistentSession: boolean;

  /** The runtime can deliver a message into a turn that is ALREADY RUNNING, without ending it. */
  supportsSteer: boolean;

  /** The runtime can append to the conversation without provoking a turn. */
  supportsContextStaging: boolean;
}
```

There is deliberately **no** `supportsQueue`. The server always owns the queue, so every runtime supports queueing by construction. That is the whole point of the ADR-0264 seam and it is why queue is the floor of the ladder.

#### 2.5 The degradation ladder

Uniform, server-side, applied before the runtime is called:

```
steer  → runtime declares supportsSteer AND a turn is open AND no pending interaction
           → deliverIntoTurn({ mode: 'steer' })
         else → queue
stage  → runtime declares supportsContextStaging
           → deliverIntoTurn({ mode: 'stage' })
         else → hold and fold into the next dispatched message as an
                `additionalContext` entry (the `queue_note` mechanism at
                `packages/shared/src/additional-context.ts:479` is the precedent)
queue  → always available
```

**Every downgrade emits a `queue_update` event carrying the `MessageDeliveryOutcome`.** The cockpit then says "queued instead of steered, Codex cannot steer mid-turn" rather than silently doing something else. `applied: 'queue', requested: 'steer', degradedBecause: 'session-idle'` is the one case the UI should stay quiet about, because "it ran immediately" is not a degradation anybody needs told.

#### 2.6 Per-runtime declarations

| Runtime       | `supportsPersistentSession` | `supportsSteer`   | `supportsContextStaging` | Basis                                                                                                                                                                                                                                                                                                                       |
| ------------- | --------------------------- | ----------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code` | `true` (after P3)           | `true` (after P4) | `true` (after P4)        | `streamInput` `sdk.d.ts:2610`; `shouldQuery` `:4764`                                                                                                                                                                                                                                                                        |
| `codex`       | `false`                     | `false`           | `false`                  | Fresh subprocess per turn (ADR-0309); its only interrupt primitive is an `AbortSignal` (`codex-runtime.ts:722-737`, `codex/NOTES.md:145-161`). Whether `@openai/codex-sdk` exposes `turn/steer` at all is **unverified**; declaring `false` is the honest answer until measured. Re-open with a live probe, not a doc read. |
| `opencode`    | `false`                     | `false`           | `false`                  | Sidecar (ADR-0308); interrupt is `POST /session/{id}/abort` (`opencode-runtime.ts:576-597`). The DOR-82 survey found OpenCode's queue lives in its own TUI, not its server.                                                                                                                                                 |
| `test-mode`   | `true`                      | `true`            | `true`                   | Exists to exercise the contract deterministically                                                                                                                                                                                                                                                                           |

All three flags land as `false` for every runtime in **P2**, so the shape is in place and conformance is green before any behavior changes. P3 flips `supportsPersistentSession` for claude-code; P4 flips the other two.

### 3. The server-owned queue

#### 3.1 Data model

New table, sibling to `session_metadata`, migrated through the standard Drizzle path:

| Column         | Type           | Notes                                                                                                                                                              |
| -------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`           | text, pk       | The `messageId`. Server-minted uuid.                                                                                                                               |
| `session_id`   | text, indexed  | Canonical session id. Re-keyed alongside the projector when a session gains its canonical id (F3's rebind already moves `session_metadata`; this joins that move). |
| `position`     | integer        | Sparse ordering so a reorder is an update, not a rewrite.                                                                                                          |
| `content`      | text           | The person's words, pristine.                                                                                                                                      |
| `disposition`  | text           | `queue` / `steer` / `stage` as requested.                                                                                                                          |
| `client_id`    | text           | Who enqueued it. Drives "queued by another window".                                                                                                                |
| `enqueued_at`  | integer        | Epoch ms.                                                                                                                                                          |
| `context_json` | text, nullable | The `ClientContext` captured at enqueue time.                                                                                                                      |

**Why persist (D5).** ADR-0264 accepts losing an in-flight _turn_ on restart. Losing a message somebody typed and was told was accepted is a different and worse promise to break. DOR-480 already established that this class of loss is unacceptable: the client queue's `restore` handle exists precisely because a refused trigger once destroyed a person's typed words (`use-message-queue.ts:13-31`).

Rows are deleted on dispatch, on explicit removal, and on session deletion. A row whose session no longer exists is swept by the same health check that evicts sessions.

#### 3.2 Contract additions (ADR-0263)

```ts
/** One message waiting to be dispatched to a session. */
export interface QueuedMessage {
  id: string;
  content: string;
  disposition: MessageDisposition;
  enqueuedAt: number;
  /** The client that enqueued it, so a window can tell its own from another's. */
  enqueuedBy: string;
}
```

- `SessionSnapshot` gains `queuedMessages: QueuedMessage[]`. This closes DOR-82's §7 Q8, which flagged that the snapshot has no queue field at all.
- A new `SessionEvent` member:

  ```ts
  | {
      type: 'queue_update';
      seq: number;
      /** The WHOLE queue, always. */
      queue: QueuedMessage[];
      /** Present when this update was caused by an accepted message. */
      outcome?: MessageDeliveryOutcome;
    }
  ```

  Full replacement rather than an incremental diff: the queue is small and bounded, and a full replacement makes every ordering and dedup bug unrepresentable.

  > **Do not miss this:** a new `SessionEvent` member must be added to the client's event allowlist or it is dropped silently. This has bitten before.

#### 3.3 Routes

| Route                                       | Behavior                                                                                                                                                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/sessions/:id/messages`           | Accepts `disposition` in the body. Returns **202 immediately** with `{ sessionId, messageId, outcome, queuePosition }`. No longer returns 409 for a busy session; no longer holds the socket for a queued turn (the DOR-1088 interim behavior). |
| `GET /api/sessions/:id/queue`               | The queue. Redundant with the snapshot, and worth having for integrations and debugging.                                                                                                                                                        |
| `PATCH /api/sessions/:id/queue/:messageId`  | Edit content or move position.                                                                                                                                                                                                                  |
| `DELETE /api/sessions/:id/queue/:messageId` | Remove.                                                                                                                                                                                                                                         |
| `POST /api/sessions/:id/interrupt`          | Unchanged shape until `runtime-interrupt-receipts` lands. Gains `cancel_queued` semantics per D4; see §3.5.                                                                                                                                     |

**409 `SESSION_LOCKED` is retired from the message POST.** The lock survives, retargeted: it stops being "who may POST" and becomes the internal dispatch mutex held for one turn window. Its liveness machinery (`LockActivity`, `session-lock.ts:22-30`, DOR-782) is unchanged and is still what reclaims a dark turn. `sessions-cross-client.test.ts` clause 3 is rewritten in P2 to assert accept-and-queue, which is what its own header (`:26-27`) said was coming.

#### 3.4 Dispatch rules

The dispatcher is the single ingress for every caller listed in §7 of the ideation (`routes/sessions.ts:695`, `session-ui-action-handler.ts:100`, `session-command-intent-handler.ts:149`, `room-turn-runner.ts:277`, `embedded-turn-trigger.ts:80` and `:148`, `tasks/run-stream.ts`, `mesh/mcp-signin-resume.ts:196`). `executeCommandIntent` for claude-code is literally `sendMessage('/compact')` (`claude-code-runtime.ts:422-430`) and contends identically, so it goes through the dispatcher too. **A caller that bypasses the dispatcher keeps the old race**; the P2 acceptance criteria include an audit that none does.

1. Dequeue on `turn_end`, never on `result` alone (FM6).
2. Never dispatch while `projector.hasPendingInteractions()` is true (FM4). That probe already exists and is already shared by the lock and the stall watchdog (`trigger-turn.ts:291`). Reuse it; do not invent a third liveness notion.
3. Dispatch is ordered by `position`, FIFO within a position.
4. Dispatch and reap share the dispatch mutex, so a reap that races a dispatch simply does not happen (FM8).

#### 3.5 Interrupt semantics (D4)

**Stop means stop everything queued.** The SDK's own documentation names this case: "A Stop-means-stop-everything client (a remote UI's Stop button) sets this true" (`sdk.d.ts:3620`, describing `cancel_queued`). A person who presses Stop with three messages queued and then watches the next one fire has been lied to.

- The server clears the DorkOS queue for the session and passes `cancel_queued: true` to the runtime where the capability is advertised (`interrupt_cancel_queued_v1` on `system/init`, `sdk.d.ts:4613`).
- Cleared messages are **returned to the client, not destroyed**: they land back in the composer's draft area, the same promise `restore` makes today.
- The confirmation names the cost: "Stop, and put 3 queued messages back?"
- Honest reporting of what was actually cancelled depends on the interrupt receipt and therefore on `runtime-interrupt-receipts` (D7). Until then the client says "stop requested".

### 4. The persistent pump

#### 4.1 Structure

New module `apps/server/src/services/runtimes/claude-code/sessions/session-pump.ts`, owned by the claude-code adapter. The SDK stays confined to that directory (Hard Rule 2).

```ts
/** Process warmth for a runtime that keeps sessions warm. */
export type SessionWarmth = 'cold' | 'warming' | 'warm' | 'running' | 'crashed';
```

The pump owns: the long-lived `query()`, its held input stream, the demux of its output into turn windows, the idle timer, and the crash detector. `executeSdkQuery` stops being "the turn" and becomes the pump's launcher. A **turn window** is a slice of the pump's output opened by a dispatch and closed by the correlated `result`.

`sdk-utils.ts`'s `createHeldPrompt` (`:73-98`) is the seam this grows out of. The DOR-1087 branch has already converted it to a queue-driven generator with `push()`. **Adopt that conversion rather than writing a second one**; coordinate so the two do not diverge.

#### 4.2 State machine

| From                | To       | Trigger                                  | Guard                                        | Side effects                                                                                    |
| ------------------- | -------- | ---------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| COLD                | WARMING  | first dispatch, or explicit warm         | under the warm ceiling (else LRU-reap first) | `query()` called with `resume` when `hasStarted`, else fresh                                    |
| WARMING             | WARM     | `system/init` received                   | —                                            | capabilities feature-detected and cached; control methods become usable                         |
| WARMING             | CRASHED  | process exit or throw before init        | —                                            | dispatch fails over to RESUMING once                                                            |
| WARM                | RUNNING  | dispatch                                 | dispatch mutex held; no pending interaction  | `turn_start` ingested; stall watchdog **armed**                                                 |
| RUNNING             | WARM     | correlated `result`                      | —                                            | one `turn_end` ingested; stall watchdog **disarmed**; idle timer **armed**; queue head dequeued |
| RUNNING             | CRASHED  | process exit or generator throw mid-turn | —                                            | open window closed with `turn_end{terminalReason:'error'}`; **queue preserved**                 |
| WARM                | REAPED   | idle timer fires, or LRU eviction        | no open turn AND no pending interaction      | `close()` on the held stream; process drains and exits                                          |
| WARM/RUNNING/REAPED | COLD     | session eviction (`checkSessionHealth`)  | —                                            | reap first, then drop the session record                                                        |
| CRASHED             | RESUMING | next dispatch                            | —                                            | fresh `query()` with `resume` set: exactly today's path, F1 and F2 included                     |
| RESUMING            | WARMING  | `query()` returns                        | —                                            | —                                                                                               |

**WARM is the new state, and it is the whole point.** Today no such state exists: the subprocess lives only inside a turn's `try/finally` and is closed at `message-sender.ts:1017-1020`. Making it real is what buys warm cache, steering, and staging. It is also what creates every new failure mode in §5.

**A warm session reports `idle`, not `streaming`.** The presence contract (`contributing/adding-a-runtime.md`) already forbids `streaming` with an empty `inProgressTurn`; WARM is a new way to get that wrong, and conformance case 4 (§6) pins it.

#### 4.3 Timers, and who owns each

| Timer                  | Constant                                                   | Default | Owner                                                                                                                             | Armed on                        | Disarmed on                      |
| ---------------------- | ---------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------- |
| **Process idle** (new) | `SESSIONS.WARM_IDLE_MS`                                    | 5 min   | `SessionPump` (adapter)                                                                                                           | turn window closes              | next dispatch                    |
| **Warm ceiling** (new) | `SESSIONS.MAX_WARM_SESSIONS`                               | 12      | pump registry (adapter)                                                                                                           | continuous LRU                  | —                                |
| Session eviction       | `SESSIONS.TIMEOUT_MS` (`constants.ts:113`)                 | 30 min  | `SessionStore.checkSessionHealth` (`session-store.ts:540-560`), swept every `INTERVALS.HEALTH_CHECK_MS` (`constants.ts:5`, 5 min) | last activity                   | activity                         |
| Turn stall             | `SESSIONS.TURN_STALL_TIMEOUT_MS` (`constants.ts:128`)      | 10 min  | `withStallGuard` (`trigger-turn.ts:378-384`)                                                                                      | **turn window opens (changed)** | **turn window closes (changed)** |
| Stall interrupt bound  | `SESSIONS.STALL_INTERRUPT_TIMEOUT_MS` (`constants.ts:137`) | 30 s    | `stall-guard.ts`                                                                                                                  | interrupt issued                | interrupt settles                |
| Lock TTL (inactivity)  | `SESSIONS.LOCK_TTL_MS` (`constants.ts:115`)                | 5 min   | `SessionLockManager`                                                                                                              | acquisition                     | release                          |
| Interaction timeout    | `SESSIONS.INTERACTION_TIMEOUT_MS` (`constants.ts:117`)     | 10 min  | `interactive-handlers.ts`                                                                                                         | interaction opens               | answer or timeout                |

Two changes hide in that table and both are load-bearing:

- **The stall watchdog must arm and disarm per turn window.** Today it spans the whole `sendMessage` generator, which today equals one turn. On a pump it would span the process, and a WARM session sitting legitimately silent for 10 minutes would be interrupted for no reason.
- **Process idle and session eviction are different timers and must not be conflated.** Eviction implies reap; reap never implies eviction. Reaping is invisible (the next message resumes), which is exactly what makes 5 minutes safe to set.

#### 4.4 Resource ceiling (D6)

`SESSIONS.MAX_SESSIONS = 50` (`constants.ts:119`, enforced at `session-store.ts:211-216`) counts session **records**. A separate, lower `MAX_WARM_SESSIONS` (default 12) counts **processes**, LRU-reaped down to the ceiling regardless of the idle timer. Fifty concurrent CLI subprocesses plus their MCP children on a laptop is not a shape to ship untested, and warmth is a cache, so LRU is exactly right for it. Records stay at 50, so `ensureSession`'s existing throw stays the genuinely exceptional path it is today.

#### 4.5 The relaunch pin list (FM9)

A warm process pins whatever it was launched with. Any change to a pinned value must **force a reap and relaunch**, or the next turn runs under stale settings. Getting this wrong bills a paying client's conversation to the wrong account, so the list is exhaustive and each entry names its source:

| Pinned                                    | Source today                                            | Change forces relaunch                                                                                 |
| ----------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `cwd`                                     | `message-sender.ts:349`                                 | yes                                                                                                    |
| Claude account root (`CLAUDE_CONFIG_DIR`) | `message-sender.ts:450`, spec `claude-code-accounts` D3 | **yes, unconditionally**                                                                               |
| Resolved credential env                   | `message-sender.ts:429` (ADR-0315)                      | yes                                                                                                    |
| Agent identity token                      | `message-sender.ts:437`                                 | yes                                                                                                    |
| `mcpServers`                              | `message-sender.ts:604-608`                             | no: use `setMcpServers` on the live query                                                              |
| `plugins`                                 | `message-sender.ts:680-686`                             | no: use `reload_plugins`, already wired (`claude-code-runtime.ts:439-448`)                             |
| `permissionMode`                          | `message-sender.ts:554-567`                             | no: `setPermissionMode` on the live query                                                              |
| `model` / `effort` / `fastMode`           | `message-sender.ts:577-602`                             | `setModel` where the SDK allows it; relaunch otherwise. **Verify per field during P3**; do not assume. |
| `systemPrompt` append                     | `message-sender.ts:401-405`                             | yes                                                                                                    |
| `settingSources`, `env`                   | `message-sender.ts:461`, `:474-495`                     | yes                                                                                                    |

### 5. Turn boundaries on a long-lived query

Today the units coincide: one `sendMessage` = one `query()` = one `result` = one `done` = one `turn_end` (`sdk-event-mapper.ts:43-46` → `result-event-mapper.ts:223-229` → `session-event-normalizer.ts:632-647`). With a pump they come apart, and the CLI can start continuations DorkOS never asked for (auto-resume continuations are named in `sdk.d.ts:3628`).

**The rule: a DorkOS turn opens on dispatch and closes on the `result` that answers it.**

1. **`closeTurn()` becomes idempotent.** Guard on `ended` in `feedProjector` (`session-event-normalizer.ts:623-647`). This alone closes F5 and ships first, as P0, because it is a latent bug regardless of anything else here.
2. **Correlation is by `messageId`, never positional.** Reasoning stated in the TSDoc in §2.2.
3. **A steer does not open a turn.** It joins the open window and rides a new `SessionEvent`:

   ```ts
   | { type: 'turn_input'; seq: number; content: string; disposition: 'steer'; messageId: string }
   ```

   The cockpit renders it inline as a user message inside the running turn, because that is what the person did. (Allowlist reminder applies.)

4. **A stage message opens no turn at all.** It emits `context_staged` so the transcript stays honest, and merges into the next dispatch per `shouldQuery: false` (`sdk.d.ts:4764`).
5. **A `result` with no correlated `messageId` opens a synthetic turn tagged `origin: 'runtime'`.** Not dropped, not disguised as a person's turn. The durable stream stays a complete account of the session, which is the same honesty rule the presence contract already enforces.

Unchanged: the ADR-0264 pipeline end to end, and `guardTurnErrors`' error-terminal translation (`trigger-turn.ts:492-530`), which must still close the open window with `status_change(error)`, a typed `error`, and exactly one `turn_end(error)`.

---

## User Experience

**Typing while the agent works.** The composer stays enabled. The message is accepted (202) and appears as a queue chip, now sourced from the server, so it survives refresh, appears in every window, and can be edited, reordered, or removed from any of them. The primary action offers **Queue** (default) with **Steer** and **Add context** beside it, and Steer and Add context are hidden, not disabled, when the runtime does not declare them. A hidden affordance is honest; a dead one is not.

**Steering.** "Also check the tests" reaches the running agent and renders inline inside the live turn. If the runtime cannot steer, the message is queued and the chip says so once: "Queued. Codex can't take messages mid-turn."

**Adding context.** Attaches for the agent to use, provokes nothing, renders as a quiet transcript entry.

**Stopping.** With a queue, the confirmation names the cost: "Stop, and put 3 queued messages back?" The messages return to the composer. Nothing a person typed is destroyed by a stop.

**A second window mid-turn.** Sees the same queue, can add to it, can remove from it. No 409, ever, on the message path.

**Nothing at all for warmth.** Warm sessions are invisible. Reap and resume are invisible. The only observable difference is that the second turn in a conversation starts faster than the first.

---

## Testing Strategy

### Conformance additions (`packages/test-utils/src/runtime-conformance.ts`)

A capability that is not conformance-tested is a capability a runtime can lie about. The suite already proves the discipline works: `validatePresenceReport` exists precisely so a runtime cannot fabricate presence.

New `RuntimeConformanceOpts`:

```ts
  /**
   * Drives ONE turn to the point where it is OPEN, calls `midTurn`, then lets it
   * close. Required for the disposition cases; without it they SKIP by name
   * rather than passing on a manufactured absence — the same stance
   * `presenceTurn` takes and for the same reason.
   */
  dispositionTurn?: (
    runtime: AgentRuntime,
    sessionId: string,
    content: string,
    probes: { midTurn: () => Promise<void> }
  ) => Promise<void>;

  /**
   * Drives a session to WARM (a completed turn, process still held) and hands
   * control back. Provided only by runtimes declaring `supportsPersistentSession`.
   */
  warmSession?: (runtime: AgentRuntime, sessionId: string) => Promise<void>;
```

New cases:

| #   | Case                                                                                                                                                                                                                                                       | Applies to          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| C1  | **Disposition honesty.** For each of `steer` / `stage`: capability declared → the message reaches the model with no new `turn_start`; not declared → `deliverIntoTurn` is absent or returns `{ delivered: false, reason: 'unsupported' }`. Neither throws. | all                 |
| C2  | **Terminal exactly once.** A turn window emits exactly one `turn_end`, however many native `result`s the backend produced.                                                                                                                                 | all                 |
| C3  | **Queue durability.** A message queued behind a turn that then FAILS still runs; a message never runs while a pending interaction is open.                                                                                                                 | all                 |
| C4  | **Warmth honesty.** A runtime declaring `supportsPersistentSession` reports `idle` with `inProgressTurn: null` while WARM.                                                                                                                                 | persistent runtimes |
| C5  | **Reap transparency.** WARM, reap, send again produces a well-formed turn. The person cannot tell.                                                                                                                                                         | persistent runtimes |
| C6  | **Capability completeness.** All three new flags present and boolean. Compile-time forced, asserted anyway so a cast cannot dodge it.                                                                                                                      | all                 |

C2 must be proved by **seeding the defect**: remove the idempotence guard, watch it go red. Prove the check can fail before trusting it.

### Per phase

| Phase  | Unit                                                                                                              | Integration                                                                                                                                                                                                                                                             | E2E / manual                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **P0** | `session-event-normalizer` idempotent `closeTurn`, defect-seeded                                                  | a scripted double-`done` stream yields one `turn_end` on the durable stream                                                                                                                                                                                             | none                                                                   |
| **P1** | (owned by DOR-1088)                                                                                               | (owned by DOR-1088)                                                                                                                                                                                                                                                     | (owned by DOR-1088)                                                    |
| **P2** | queue store CRUD, ordering, dispatch gating on pending interactions, ladder resolution table                      | full route pass over the real projector: enqueue → snapshot carries it → `queue_update` on the stream → dispatch on `turn_end` → row gone. Restart mid-queue: rows survive, dispatch resumes. `sessions-cross-client.test.ts` clause 3 rewritten to accept-and-queue    | Playwright: two windows, one queue; refresh mid-queue; queue survives  |
| **P3** | pump state machine transition-by-transition; idle timer; LRU ceiling; pin-list relaunch triggers; crash → resume  | one pump, many turns: warm across turns, correlation by `messageId`, stall watchdog arms and disarms per window, reap-then-send is transparent. Live smoke behind `DORKOS_CLAUDE_LIVE=1` in the same file, per the mocking stance in `contributing/adding-a-runtime.md` | manual: 10 consecutive turns, watch process count and cache-read ratio |
| **P4** | `deliverIntoTurn` for both modes; degradation ladder per runtime; `turn_input` and `context_staged` normalization | conformance C1–C6 green on all four runtimes; a steer mid-turn reaches the model with no second `turn_start`                                                                                                                                                            | Playwright: steer mid-turn; steer on Codex shows the downgrade notice  |
| **P5** | DOR-1087 tripwire fires on a synthetic phantom                                                                    | phantom rate measured over a multi-subagent session                                                                                                                                                                                                                     | measurement pass (§Performance)                                        |

**Mocking stance is non-negotiable and unchanged:** CI never requires a backend binary. Mock the SDK with recorded fixtures, mock the dependency probe, gate live smokes behind an env flag in the same file.

**One trap worth naming:** run every test that renders or mounts a changed component, not just the component's own suite. A component suite green with a wizard test red in CI has happened here before.

---

## Performance Considerations

The performance claim is the **justification** for this work, so it must be measured rather than asserted. The ideation deliberately marked its cost estimates unverified, and this spec does not upgrade them.

**The measurement that decides P5**, taken on the same workload with the flag off and on:

| Metric                       | Source                                                              | Expectation                                   |
| ---------------------------- | ------------------------------------------------------------------- | --------------------------------------------- |
| Time to first token, turn 2+ | span `SESSION_TURN`, already instrumented (`trigger-turn.ts:333`)   | materially lower (no spawn, no MCP reconnect) |
| Cache-read token ratio       | `session_status.cacheReadTokens` (`result-event-mapper.ts:166-181`) | materially higher                             |
| Resident subprocess count    | process sampling                                                    | bounded by `MAX_WARM_SESSIONS`                |
| Phantom-cancellation rate    | DOR-1087 tripwire                                                   | zero                                          |

**Risks.** A warm process holds memory for its whole idle window; the ceiling bounds this. LRU thrash is possible on a host with many active sessions; the metric to watch is reap-then-immediately-rewarm frequency, and the remedy is raising the ceiling, not lengthening the idle timer.

---

## Security Considerations

- **Account and credential pinning is the highest-severity item in this spec.** A warm process pins `CLAUDE_CONFIG_DIR` at launch (`message-sender.ts:450`). A session that changes account without a relaunch would run and **bill** on the wrong account. The pin list (§4.5) is a security control, not an optimization detail, and its account row is unconditional.
- **Credential rotation** must invalidate warm processes. A revoked credential resolved at `message-sender.ts:429` must not keep working because a process launched before the revocation is still alive.
- **Boundary validation** (`validateBoundaryOrDorkHome`, `message-sender.ts:351`) happens per turn today. On a pump it must happen per **dispatch**, not per launch, or a cwd change would slip past the boundary check.
- **Queue content is user text and is now persisted.** It lives in the same SQLite store as the rest of session metadata, under the same `~/.dork/` ownership, and never leaves the host.
- **A steer is a write.** `deliverIntoTurn` must be subject to the same authorization as `sendMessage`; there is no path where a caller that may not send may steer.

---

## Documentation

| Doc                                  | Change                                                                                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contributing/adding-a-runtime.md`   | The three new capability flags, the ladder, `deliverIntoTurn`, and the new conformance cases with their drivers. This is the guide a runtime author reads; the flags are worthless if it does not explain how to declare them honestly. |
| `contributing/architecture.md`       | The pump and the server queue in the hexagonal picture.                                                                                                                                                                                 |
| `docs/integrations/sse-protocol.mdx` | `queue_update`, `turn_input`, `context_staged`; the retirement of 409 from the message POST. This is the public integration contract.                                                                                                   |
| `docs/` (user-facing)                | Queue, steer, add-context, and what Stop does to queued messages. Per `writing-for-humans`.                                                                                                                                             |
| `changelog/unreleased/`              | One fragment per phase.                                                                                                                                                                                                                 |
| `decisions/`                         | Three ADRs (§Related ADRs).                                                                                                                                                                                                             |

---

## Implementation Phases

Each phase is independently shippable and independently revertable. Rollout is **per-session opt-in via config**, defaulting off, promoted later: a config field under `runtimes.claudeCode` in `packages/shared/src/config-schema.ts` plus the semver-keyed migration the `adding-config-fields` skill requires. Not a global flag and not a hard cutover, because the two paths must run side by side on one host to be comparable, and the fallback path is not going away.

### P0 — Idempotent `closeTurn` (F5)

**Scope.** Guard `feedProjector`'s `closeTurn()` on `ended` (`session-event-normalizer.ts:623-647`). No flag.

**Acceptance.**

- A stream carrying two `done` events produces exactly one `turn_end`.
- The defect-seeded test goes red with the guard removed.
- No behavior change on any single-`result` turn: the existing suite is green untouched.

**Reverts by:** `git revert`.

### P1 — DOR-1088 serialization

**Scope.** Owned by `worktree-dor-1088-stream-serialize`, not by this spec. Listed so the dependency is explicit.

**Acceptance (this spec's requirement of it).**

- Two same-client triggers on one session run strictly in sequence; the second's turn starts only after the first's lock is released.
- A second **client** still meets the lock's unchanged 409-then-takeover answer.
- `session.activeQuery` is cleared only by the frame that owns it.
- A throw before the turn launches releases both the lock and the queue slot.

**Reverts by:** flag off, back to 409.

### P2 — Server-owned queue

**Scope.** Queue table and migration; `QueuedMessage`, `queue_update`, snapshot field, client allowlist; queue routes; dispatcher as the single ingress with the audit of all callers in §3.4; disposition envelope accepted at ingress with all dispositions resolving to `queue`; all three capability flags declared `false` on every runtime; client cutover from the ADR-0104 queue to the server queue, preserving every existing affordance including `restore`; `sessions-cross-client.test.ts` clause 3 rewritten; ADR-0104 superseded.

**Acceptance.**

- A message POSTed to a busy session returns 202 with a `messageId` and a queue position. **No 409 on the message path, ever.**
- The queue appears in `SessionSnapshot` and updates on `queue_update` in every connected window.
- A queued message survives a client refresh, a second window, a **failed** turn, and a **server restart**.
- A queued message never dispatches while a pending interaction is open.
- Every trigger caller in §3.4 routes through the dispatcher; the audit is a test, not a claim.
- Queue mutation from window B is visible in window A.

**Reverts by:** flag off, client falls back to its local queue.

### P3 — Persistent pump, opt-in

**Scope.** `session-pump.ts`; state machine; turn windowing with `messageId` correlation; idle timer and `MAX_WARM_SESSIONS` LRU; the pin list and its forced relaunches; crash detection to `CRASHED` to `RESUMING`; stall-watchdog arm/disarm per window; `getSessionWarmth` / `reapSession`; config field and migration; `supportsPersistentSession: true` for claude-code.

**Acceptance.**

- Ten consecutive turns in one session run on **one** subprocess; the process count does not grow.
- A warm session reports `idle` with `inProgressTurn: null` (conformance C4).
- Reap after the idle window, then send: the turn is well formed and the person cannot tell (C5).
- Reap never happens while a pending interaction is open.
- Killing the subprocess mid-turn closes that turn with `turn_end{terminalReason:'error'}`, **preserves the queue**, and the next dispatch resumes.
- Every pinned value in §4.5 forces a relaunch when changed; the account row is proved by a test that would otherwise bill the wrong account.
- The stall watchdog does not fire on a WARM session silent past `TURN_STALL_TIMEOUT_MS`.
- Flag off: byte-for-byte today's resume-per-message behavior.

**Reverts by:** flag off.

### P4 — Dispositions native, capabilities, conformance

**Scope.** `deliverIntoTurn` for claude-code (`streamInput` for steer, `shouldQuery: false` for stage); `turn_input` and `context_staged` events plus allowlist; the degradation ladder and its downgrade notice; honest flags on all four runtimes; conformance C1–C6 with their drivers; composer affordances; interrupt-receipt integration where `runtime-interrupt-receipts` has landed.

**Acceptance.**

- A steer reaches the running agent with **no second `turn_start`**, and renders inline inside the live turn.
- A stage message provokes **no turn** and merges into the next dispatch.
- A steer requested against Codex or OpenCode is queued, and the outcome carries `requested: 'steer', applied: 'queue', degradedBecause: 'unsupported'`; the UI says so once.
- A steer requested against an idle session runs immediately and the UI stays quiet about it.
- Conformance C1–C6 green on claude-code, codex, opencode, test-mode.
- Stop clears the queue, returns the messages to the composer, and the confirmation names the count.

**Reverts by:** capability flags to `false`; the ladder degrades everything to `queue`.

### P5 — Default on, measure, clean up

**Scope.** The measurement pass in §Performance; flip the config default; watch the DOR-1087 tripwire; remove the phantom detector after a quiet period.

**Acceptance.**

- Turn-2 time-to-first-token and cache-read ratio both improved on the same workload, with numbers recorded on the work item.
- Resident subprocess count bounded by `MAX_WARM_SESSIONS` under a 20-session soak.
- The DOR-1087 tripwire records **zero** phantoms over the quiet period. If it fires even once, P5 does not complete and the design is re-opened.
- The phantom detector is removed as a **scheduled task**, never as an assumption.

**Reverts by:** flag off.

---

## Open Questions

All ideation decisions D1 through D10 were approved by the coordinator and are frozen as specified: D1 envelope plus interrupt verb (§2.1), D2 queue default (§2.2), D3 no `priority` reliance (§Non-Goals N3), D4 stop cancels queued (§3.5), D5 persist the queue (§3.1), D6 separate warm ceiling (§4.4), D7 depend do not absorb (§Technical Dependencies), D8 replace ADR-0104 preserving UX (§P2), D9 stage ships last (§P4), D10 DOR-1087 tripwire through P5 (§P5).

Three questions the drafting itself surfaced, all resolved:

**~~Q1: can `steer` ride `sendMessage`'s return type?~~ (RESOLVED)**
**Answer:** No. `sendMessage` returns `AsyncGenerator<StreamEvent>` and `feedProjector` consumes one such generator as exactly one turn. A steer's events belong to a turn whose generator is already being consumed elsewhere, so a steer cannot return a turn-shaped generator without two `feedProjector` calls fighting over one turn.
**Rationale:** D1's intent was "one envelope at the ingress, not three new required runtime verbs", and that is preserved exactly: `disposition` is a single ingress field, and the runtime interface grows **one optional** method rather than three required ones. `deliverIntoTurn` returns a receipt because the events surface on the already-open turn's stream, which is the honest shape.

**~~Q2: does DOR-1088's `SessionTurnQueue` become the server queue?~~ (RESOLVED)**
**Answer:** No. It stays as the internal ordering primitive; P2 builds the durable queue above it and stops holding the HTTP socket.
**Rationale:** DOR-1088's chain is in-memory, per-client, invisible to other windows, lost on restart, and holds a socket per waiting message. Those are correct choices for a correctness fix shipping now and wrong ones for the product feature. Keeping both, with the durable queue owning the person-facing promise and the chain owning intra-process ordering, means P2 changes behavior without rewriting a primitive that will already be proven in production.

**~~Q3: should the stall watchdog also cover the WARM state?~~ (RESOLVED)**
**Answer:** No. It arms on turn-window open and disarms on close. WARM silence is bounded by the idle timer instead.
**Rationale:** The watchdog exists to end a turn that has gone dark (`constants.ts:120-129`). A WARM session is not a turn and has nothing to end; interrupting one would kill a healthy process for the crime of waiting. The idle timer is the right bound for silence with no turn open, and it is shorter (5 min) than the watchdog (10 min) anyway.

---

## Related ADRs

### Existing, constraining

| ADR                                                    | Relationship                                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **0264** server-owned durable resumable session stream | The seam. Trigger-only POST is where the queue belongs; its restart loss boundary is inherited (N1)                   |
| **0263** runtime-neutral snapshot + event contract     | Extended by `queue_update`, `turn_input`, `context_staged`, and `queuedMessages`                                      |
| **0104** client-side message queue with auto-flush     | **Superseded** by ADR-c below                                                                                         |
| **0075** per-agentId promise chain for CCA concurrency | Same shape as DOR-1088's `SessionTurnQueue`, at the relay layer; the dispatcher subsumes its role for cockpit traffic |
| **0310** runtime-owned storage, aggregated listing     | The per-runtime degradation stance the ladder follows                                                                 |
| **0256** `features` as a typed extension point         | Why the three new flags are first-class fields, not bag entries                                                       |
| **0273** neutral additional-context bag                | How `stage` fallback content reaches a turn without mutating `content`                                                |
| **0315** credential reference resolution               | The credential pin (§4.5, §Security)                                                                                  |

### Draft ADR candidates to seed at DECOMPOSE

Listed here per the coordinator's instruction; **no ADR files created by this spec.**

| Candidate | Title                                                                                 | Status it would carry                                | Notes                                                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ADR-a** | Three message dispositions at the `AgentRuntime` boundary                             | `draft`, `extractedFrom: persistent-session-runtime` | The envelope-plus-`deliverIntoTurn` split (§2), the three capability flags, and the degradation ladder. Records the rejected alternative (three required runtime verbs) and why Q1 forced the split.                                     |
| **ADR-b** | Persistent streaming-input sessions for claude-code, with resume as the recovery path | `draft`, `extractedFrom: persistent-session-runtime` | The WARM state, the two-timer model and their owners, the warm ceiling, and the pin list. Records the rejected alternative (keep resume-per-message and queue only at our layer) and the deliberate non-goal of surviving a restart.     |
| **ADR-c** | Server-owned durable message queue                                                    | `draft`, `extractedFrom: persistent-session-runtime` | **Supersedes ADR-0104.** Amends ADR-0264 by naming the queue as the thing behind the trigger-only POST, which ADR-0264's own context anticipated. Records the persistence decision (D5) and the retirement of 409 from the message path. |

Whether the `priority`-field question (D3) earns its own ADR is a DECOMPOSE call. The recommendation is no: "we measured nothing and therefore relied on nothing" is a note in ADR-b, not a decision record of its own.

---

## References

- `research/20260610_message_queuing_agent_runtimes.md` (DOR-82): the four-pattern taxonomy, the cross-runtime matrix, and the recommendation this spec executes. Its §7 questions Q1, Q2, Q4, Q5, Q8 are answered here.
- [`01-ideation.md`](01-ideation.md): the full evidence trace with verified `file:line` pointers at `e4b9e1a9b`.
- `specs/runtime-interrupt-receipts/01-ideation.md` (`260807-231651`), `specs/runtime-prompt-redelivery/01-ideation.md` (`260807-231653`): adjacent specs; boundaries in D7.
- `contributing/adding-a-runtime.md`: the runtime author contract, the presence-truthfulness stance, and the mocking stance.
- `packages/test-utils/src/runtime-conformance.ts`: the suite to extend; `RuntimeConformanceOpts` at `:44-131`, driver pattern at `presenceTurn` / `durableHistory`.
- `@anthropic-ai/claude-agent-sdk@0.3.224` `sdk.d.ts`: `streamInput` `:2610`, `interrupt` `:2346`, `reinitialize` `:2452`, `priority` `:4757` (still undocumented), `shouldQuery` `:4764`, `cancel_queued` `:3620`, capability feature-detection `:4613`.
- `worktree-dor-1088-stream-serialize`: the serialization prerequisite, read at time of writing.
- `worktree-dor-1087-phantom-stop`: the phantom-cancellation characterization and the `push()`-capable held prompt this spec adopts.
