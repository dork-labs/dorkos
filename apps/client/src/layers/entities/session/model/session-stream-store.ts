/**
 * Per-session stream store — pure Zustand state hydrated from the runtime-neutral
 * session contract (snapshot → resumable event stream, spec
 * chat-stream-reconnection).
 *
 * Holds the projected client-side mirror of each session's server state: the
 * completed message history, the in-progress turn (as a list of {@link SessionEvent}s),
 * the held {@link SessionStatus}, recoverable pending interactions, and the seq
 * cursor bookkeeping that makes event application idempotent and gap-free. It is
 * the single owner of `lastAppliedSeq`: {@link SessionStreamActions.applyEvent}
 * no-ops on a duplicate/out-of-order seq, so the StreamManager (shared layer) can
 * forward every validated frame without dedup. LRU-evicts idle sessions past
 * {@link MAX_RETAINED_SESSIONS}, except the one session named by
 * {@link SessionStreamActions.setPinnedSession} (DOR-298 PIP), which survives
 * eviction regardless of idle state.
 *
 * This module is pure state — it imports NOTHING from the StreamManager. The
 * binding (`session-stream-binding.ts`) wires the two together so the
 * entities→shared dependency direction stays one-way (FSD).
 *
 * @module entities/session/model/session-stream-store
 */
import { useCallback } from 'react';
import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type {
  BackgroundTaskStatus,
  ConnectionState,
  ErrorEvent as TurnErrorEvent,
  HistoryMessage,
  PendingInteractionDTO,
} from '@dorkos/shared/types';
import type {
  SessionEvent,
  SessionStatus,
  SessionSnapshot,
  SessionContextUsage,
  SessionLifecycle,
} from '@dorkos/shared/session-stream';
import {
  isAbsolvingTerminalReason,
  isInterruptedTerminalReason,
  isNonFatalErrorCode,
} from '@dorkos/shared/schemas';
import type { MessageDeliveryOutcome, QueuedMessage } from '@dorkos/shared/schemas';

/** Maximum number of sessions retained before LRU eviction (mirrors the chat store). */
const MAX_RETAINED_SESSIONS = 20;

/**
 * Client-side projection of a single session's server state, hydrated from a
 * {@link SessionSnapshot} and advanced by {@link SessionEvent}s.
 */
export interface SessionStreamState {
  /** Completed message history for the session (from the snapshot). */
  messages: HistoryMessage[];
  /**
   * The just-submitted user message, held optimistically until `turn_end`
   * reconciliation folds it into `messages` via the canonical history reload.
   *
   * The `/events` stream carries no user-message event (it is assistant-side
   * only) and the snapshot was captured before this send, so without this the
   * user's own message would not render until the next history load. Cleared by
   * the turn_end reconcile (and on send failure). A single pending message
   * covers the common one-send-per-turn case.
   */
  optimisticUserMessage: { id: string; content: string } | null;
  /**
   * The messages waiting behind this session's running turn, in dispatch order,
   * exactly as the SERVER holds them (spec `persistent-session-runtime`).
   *
   * A projection, never a source of truth: it is replaced wholesale by the
   * hydration snapshot and by every `queue_update`, and nothing in the client
   * writes to it. That is the point of the cutover — the queue survives a
   * refresh, shows up in every window, and outlives a failed turn, because the
   * server is the one holding it (ADR-0104 superseded).
   */
  queuedMessages: QueuedMessage[];
  /**
   * The delivery receipt for each still-waiting message, keyed by message id.
   *
   * Only messages whose acceptance said something worth repeating are in here —
   * a `queue_update` carries an outcome only when an accepted message caused it.
   * Pruned to the live queue on every update, so a dispatched message takes its
   * receipt with it.
   */
  queueOutcomes: Record<string, MessageDeliveryOutcome>;
  /** Events of the turn in progress; empty when the session is idle. */
  inProgressTurn: SessionEvent[];
  /** Server-held status projection, or `null` before the first hydration. */
  status: SessionStatus | null;
  /** Pending interactions awaiting the operator (ADR-0264), keyed by `id`. */
  pendingInteractions: PendingInteractionDTO[];
  /** Highest `seq` applied so far; the idempotency/gap-free watermark. */
  lastAppliedSeq: number;
  /**
   * `Date.now()` when this session last APPLIED a frame (snapshot or event), or
   * `null` before the first hydration. Diagnostics-only: heartbeats and comment
   * frames keep an SSE connection `connected` without advancing the projection,
   * so a healthy connection paired with a long-stale timestamp is exactly the
   * signature of a stream that has quietly stopped delivering.
   */
  lastEventAt: number | null;
  /** Cursor of the most recent snapshot, or `null` before first hydration. */
  streamReadyCursor: number | null;
  /** Connection state of this session's durable `/events` stream. */
  connectionState: ConnectionState;
  /**
   * True from the moment a turn is triggered (POST sent) until the server's
   * `turn_start` arrives. Closes the double-submit window (CLI-B7): the POST is
   * a 202 trigger, so without this the composer reads `idle` for a full RTT +
   * turn-spin-up after Enter and a second Enter would send a duplicate instead
   * of queueing. Cleared by `turn_start`/`turn_end`, on trigger failure, and by
   * the submit hook's watchdog if the turn never materializes.
   */
  triggerPending: boolean;
  /**
   * Incremented every time {@link SessionStreamActions.applySnapshot} hydrates
   * this session. Lets edge-detection consumers (the turn-end reconcile)
   * distinguish a LIVE lifecycle transition from a snapshot-induced one: a
   * switch-back/cold-reconnect snapshot that reports `idle` where the stale
   * projection said `streaming` is a discovery of an old settle, not a live
   * settle edge (no notification sound, no redundant history reload — the
   * snapshot itself carries fresh history).
   */
  hydrationGeneration: number;
  /**
   * Sign-in flows whose one turn of grace is already spent (DOR-1004).
   *
   * Held EXPLICITLY, and that is the whole point. The grace mark used to be
   * inferred — "this list already contains a `turn_start`, so its card has been
   * through a turn" — which read a fact off data another code path deletes:
   * `retainOpenSigninCards` strips everything but the sign-in events on every
   * settled turn, `turn_start` included. So each history reload silently handed
   * the receipt a fresh turn of grace and it never retired at all, while the
   * server retired it after one. Two projections of the same conversation
   * disagreeing about what is on screen is the bug this field exists to make
   * impossible.
   *
   * Bounded by construction: an id is kept only while its card is still on
   * screen, and dropped with it.
   */
  carriedSigninFlowIds: string[];
  /**
   * Background children this projection has watched START and not yet watched
   * finish, by `taskId` (DOR-1100).
   *
   * Exists because a background task OUTLIVES the turn that launched it, and the
   * only per-turn record of it does not: `inProgressTurn` is wiped by the
   * turn-end reconcile's history reload, so a fold over it reports zero running
   * children about a second after the turn closes — while the children are still
   * working. That is the exact window this session state is for. Holding the ids
   * at the session level rather than the turn level is what makes
   * {@link SessionStatus.runningSubagentCount} stay true across a turn boundary,
   * in parity with the server projector, which has always tracked its own set
   * that way.
   *
   * Bounded by construction: an id enters when it starts and leaves when it
   * reaches any terminal status.
   */
  runningSubagentIds: string[];
  /**
   * Children the SERVER counted at hydration that this projection cannot name.
   *
   * A cold snapshot carries the count but not the ids of children started in an
   * earlier turn, so those cannot go in {@link runningSubagentIds}. Counting them
   * separately is what keeps the total honest in both directions: without this
   * field a mid-background-work refresh would report zero (dropping the server's
   * own count), and folding them INTO the id list would double-count the next
   * progress report for a child the client can in fact name.
   *
   * Decremented — never below zero — when a terminal update arrives for an id
   * this projection never saw start, because that is what one of these finishing
   * looks like from here.
   */
  unnamedRunningSubagents: number;
  /**
   * Who opened the turn window currently held — `'user'` for one a person or a
   * caller triggered, `'runtime'` for one the agent opened on its own after a
   * background task woke it (DOR-1100).
   *
   * Read at the SETTLE edge, which is the only place it matters: the
   * turn-finished notification is an answer to a request, so a window nobody
   * requested must not sound it again for the same request. Survives `turn_end`
   * deliberately — the settle handler runs after it and needs to know what just
   * settled.
   */
  turnOrigin: 'user' | 'runtime';
  /**
   * How many turns a PERSON (or a caller) has started on this session since it
   * hydrated. Runtime-opened wake-up windows never move it.
   *
   * A counter rather than an edge, and that is the whole design. The settle
   * handler needs to know "is this a new thing somebody asked for?", and the
   * obvious way to answer — watch for a `turn_start` — cannot survive batching: a
   * `Last-Event-ID` reconnect replays a whole gap in one React commit, so a
   * `turn_end` and the wake-up's `turn_start` land together and the
   * streaming→settled edge between them never exists to be observed. A count
   * that CHANGED across a commit is still a fact no matter how many events were
   * folded into it.
   */
  userTurnCount: number;
}

/** Default state for an un-hydrated session. */
export const DEFAULT_SESSION_STREAM_STATE: SessionStreamState = {
  messages: [],
  optimisticUserMessage: null,
  queuedMessages: [],
  queueOutcomes: {},
  inProgressTurn: [],
  status: null,
  pendingInteractions: [],
  lastAppliedSeq: 0,
  lastEventAt: null,
  streamReadyCursor: null,
  connectionState: 'connecting',
  triggerPending: false,
  hydrationGeneration: 0,
  carriedSigninFlowIds: [],
  runningSubagentIds: [],
  unnamedRunningSubagents: 0,
  turnOrigin: 'user',
  userTurnCount: 0,
};

/** `SessionEvent` member discriminants that map onto a {@link PendingInteractionDTO}. */
type InteractionEvent = Extract<
  SessionEvent,
  { type: 'approval_required' | 'question_prompt' | 'elicitation_prompt' }
>;

/** Maps an interaction `SessionEvent.type` to its {@link PendingInteractionDTO} `type`. */
const INTERACTION_DTO_TYPE = {
  approval_required: 'approval',
  question_prompt: 'question',
  elicitation_prompt: 'elicitation',
} as const;

/**
 * Convert an interaction {@link SessionEvent} into the {@link PendingInteractionDTO}
 * the UI renders. The event carries the same fields as the DTO (id, timer, and
 * type-specific payload) under a different `type` discriminant, so this strips the
 * `seq`/`type` and re-tags with the DTO discriminant.
 */
function interactionEventToDTO(event: InteractionEvent): PendingInteractionDTO {
  const { seq: _seq, type, ...rest } = event;
  return { ...rest, type: INTERACTION_DTO_TYPE[type] } as PendingInteractionDTO;
}

/** A fully-zeroed {@link SessionContextUsage}; base for the first partial delta. */
const ZERO_CONTEXT_USAGE: SessionContextUsage = {
  totalTokens: 0,
  maxTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/**
 * Field-wise-merge a partial `status_change.status` delta onto the held status,
 * mirroring the server projector's merge: `contextUsage` is merged field-wise
 * onto the prior value (a streaming delta carries only `outputTokens`; a final
 * one carries totals but no `outputTokens` — a wholesale replace would let each
 * delta zero the fields it omits). Absent fields keep their prior value.
 */
function mergeStatus(
  prior: SessionStatus | null,
  partial: Extract<SessionEvent, { type: 'status_change' }>['status']
): SessionStatus {
  const { contextUsage, ...rest } = partial;
  // `prior` is non-null in practice (a snapshot always hydrates status before any
  // event applies), but fall back to the partial's own fields for safety.
  const base = (prior ?? (rest as SessionStatus)) as SessionStatus;
  const merged: SessionStatus = { ...base, ...rest };
  if (contextUsage !== undefined) {
    merged.contextUsage =
      contextUsage === null
        ? null
        : { ...(merged.contextUsage ?? ZERO_CONTEXT_USAGE), ...contextUsage };
  }
  return merged;
}

/** Push-to-in-progress-turn event types (assistant output and progress events). */
const TURN_EVENT_TYPES: ReadonlySet<SessionEvent['type']> = new Set([
  'text_delta',
  'thinking_delta',
  'tool_call',
  'tool_result',
  'tool_progress',
  'subagent_update',
  'todo_update',
  'hook_update',
  'memory_recall',
  // Retained so the live turn feeds `useSystemStatusEvents` (session-hook flashes
  // → status strip). The bubble projection produces no part for a `system_status`,
  // so this adds no stray parts. Without it the strip's producer is starved live
  // and only the durable history reload shows these states (DOR-125).
  'system_status',
  // Retained so the live turn feeds the status strip's progress treatment
  // (compaction start→done) and the projection's failed-compaction row. The
  // bubble projection produces a part only for a `failed` phase (DOR-110).
  'operation_progress',
  // The boundary a SUCCESSFUL compaction leaves, so the reader sees it land
  // rather than only meeting it on the next history reload (DOR-1215). Its
  // projection (`foldCompactBoundary`, DOR-118) and row (`CompactBoundaryRow`)
  // both shipped; only this line was missing, so nothing live ever reached
  // them — while a FAILED compaction drew its row all along, because that one
  // is synthesized from the `operation_progress` above.
  'compact_boundary',
  // An in-session capability approval hold and its resolution (DOR-939) ride the
  // turn so the inline approval card folds into the bubble and retires on the
  // resolution. They do NOT enter `pendingInteractions` — the hold has no
  // recovery DTO; its card recovers from the in-progress-turn replay.
  'capability_approval_required',
  'capability_approval_resolved',
  // An in-conversation MCP sign-in card and its resolution (DOR-1004). Ride the
  // turn like the approval pair, but the card deliberately OUTLIVES the turn —
  // see `retainOpenSigninCards`, which is what keeps it on screen while a person
  // is off in their browser.
  'mcp_signin_required',
  'mcp_signin_resolved',
  // A steer delivered into the open turn (spec `persistent-session-runtime` §P4).
  // Rides `inProgressTurn` so it renders inline where it arrived; the projection
  // (`projectSessionMessages`) splits the turn at it into an inline user bubble.
  // It never opens or closes a turn — the default arm just pushes it.
  'turn_input',
  // A staged-context receipt (spec `persistent-session-runtime` §2.5, task 4.2).
  // Staging is only ever offered while a turn is open, so it rides that turn like
  // a steer does — but the projection renders it as a QUIET note, not a bubble:
  // the person added context for the next turn without cutting into this one.
  'context_staged',
]);

/** The two event types that make up a sign-in card and its receipt (DOR-1004). */
const SIGNIN_CARD_EVENT_TYPES: ReadonlySet<SessionEvent['type']> = new Set([
  'mcp_signin_required',
  'mcp_signin_resolved',
]);

/**
 * The events a cleared turn keeps: a sign-in card, and the resolution that
 * turned it into a receipt (DOR-1004).
 *
 * Everything else a turn produced is in the reloaded history by the time this
 * runs, which is exactly why the turn is cleared. A sign-in is not: it was asked
 * for in DorkOS, it is answered minutes later in a browser tab, and the runtime's
 * own transcript has never heard of it. Clearing it with the rest would delete
 * the link a person walked away to use — the single most likely moment for them
 * to come back and look — and, once signed in, the only record in the whole
 * conversation of what they just authorized.
 *
 * BOTH halves are kept, unfiltered: the card carries the server name and the
 * disclosure, the resolution carries how it ended, and the fold needs the pair to
 * render either state. Grace is spent at `turn_start` ({@link carrySigninCards}),
 * not here — a history reload is not the conversation moving on.
 *
 * @param events - The settling turn's events.
 * @returns The events to keep, in their original order.
 */
function retainOpenSigninCards(events: SessionEvent[]): SessionEvent[] {
  return events.filter((event) => SIGNIN_CARD_EVENT_TYPES.has(event.type));
}

/**
 * Drop everything before the CURRENTLY OPEN window, keeping any sign-in card the
 * dropped prefix held (DOR-1100).
 *
 * The preserve path exists for one situation — a new turn started while the
 * history reload was in flight, so clearing the turn would wipe events the
 * reload predates. It used to be able to keep the whole turn because a
 * `turn_start` reset it, which meant "the whole turn" and "the new window" were
 * the same thing. A runtime-opened window APPENDS instead (so the finished reply
 * does not blank while the agent wakes up), and that broke the equivalence: the
 * turn now also holds the FINISHED window's deltas, which the reload has just
 * supplied as canonical history. Preserving all of it renders the reply twice
 * for as long as the wake-up runs.
 *
 * So the preserve is narrowed to what the reload genuinely predates: the events
 * at or after the last `turn_start`. A sign-in card from the prefix still
 * survives, for the same reason it survives a full clear — the runtime's
 * transcript has never heard of it.
 *
 * @param events - The live turn, possibly spanning several windows.
 * @returns The current window, preceded by any sign-in card from before it.
 */
/**
 * The most events one live turn may hold on the client before the finished
 * windows behind it are dropped (DOR-1100).
 *
 * A turn used to be self-limiting: every `turn_start` reset it, so the only way
 * to grow was to keep streaming, and the server's own `RingBuffer` caps the
 * replayable turn at the same 200. A runtime-opened window appends instead, so a
 * chain of wake-ups — one background task waking the agent, whose work starts
 * another — accumulates until a reload trims it. Normally that reload lands
 * within a round trip and this never bites; if it fails or the chain outruns it,
 * this is the bound that keeps a long-lived tab from growing without limit.
 *
 * Matched to `RING_BUFFER_MAX_EVENTS` deliberately: past it the server could not
 * replay the turn to a reconnecting client either, so keeping more here would
 * hold events no cold hydrate could reproduce.
 */
const MAX_LIVE_TURN_EVENTS = 200;

/**
 * Drop whole finished windows off the front of an over-long live turn, keeping
 * any sign-in card they held.
 *
 * Trims by WINDOW, never mid-window: half a window renders as a reply that
 * starts mid-sentence, which is worse than one that is missing. So an
 * over-budget turn gives up its oldest complete window and re-checks, and a
 * single window over budget on its own is left alone — there is nothing to drop
 * that would not be a lie.
 *
 * The oldest window does NOT always start at index 0: a retained sign-in card
 * sits ahead of it (`retainOpenSigninCards`, and the same card is why the trim
 * puts one back). Finding the first `turn_start` before looking for the next is
 * what makes the cut land a whole window later than that card, rather than on
 * the card itself — cutting there dropped nothing, and the cap silently stopped
 * applying for the rest of the session (DOR-1107).
 *
 * @param events - The live turn, possibly spanning several windows.
 */
function boundLiveTurn(events: SessionEvent[]): SessionEvent[] {
  let kept = events;
  while (kept.length > MAX_LIVE_TURN_EVENTS) {
    const oldestWindow = kept.findIndex((event) => event.type === 'turn_start');
    if (oldestWindow === -1) break;
    const nextWindow = kept.findIndex(
      (event, index) => index > oldestWindow && event.type === 'turn_start'
    );
    // Nothing but the oldest window left: over budget on its own, and dropping
    // part of it would render a reply starting mid-sentence.
    if (nextWindow === -1) break;
    // Always strictly shorter — the dropped prefix holds that `turn_start`, and
    // only sign-in cards come back — so the loop cannot spin.
    kept = [...retainOpenSigninCards(kept.slice(0, nextWindow)), ...kept.slice(nextWindow)];
  }
  return kept;
}

function retainCurrentWindow(events: SessionEvent[]): SessionEvent[] {
  // Hand-rolled reverse scan: the client's `lib` target predates
  // `findLastIndex`, and one loop is cheaper than raising it for one call.
  let windowStart = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn_start') {
      windowStart = i;
      break;
    }
  }
  if (windowStart <= 0) return events;
  return [...retainOpenSigninCards(events.slice(0, windowStart)), ...events.slice(windowStart)];
}

/** The flow a sign-in card event belongs to. Both members carry `flowId`. */
function signinFlowIdOf(event: SessionEvent): string {
  return (event as Extract<SessionEvent, { type: 'mcp_signin_required' }>).flowId;
}

/**
 * Spend one `turn_start` of every carried sign-in card's grace, retiring the
 * ones that had already spent theirs (DOR-1004).
 *
 * The client half of the server projector's rule of the same name, and written
 * to be read beside it: signing in triggers a resume turn almost immediately, so
 * clearing the turn on its `turn_start` erased the receipt about a second after
 * it appeared. A card therefore survives exactly one `turn_start`, and the next
 * one retires it.
 *
 * The mark is CARRIED IN, not derived. Deriving it from the event list looked
 * tidier and was wrong: the reload path strips the very `turn_start` the
 * derivation read, so every reload restored the grace and the receipt became
 * permanent.
 *
 * @param events - The outgoing turn's events.
 * @param spentFlowIds - Flows whose grace was already spent.
 * @returns The events the new turn starts with (before its own `turn_start`),
 *   and the flows that have now spent their grace.
 */
function ageSigninCards(
  events: SessionEvent[],
  spentFlowIds: readonly string[]
): { kept: SessionEvent[]; spentFlowIds: string[] } {
  const spent = new Set(spentFlowIds);
  const kept: SessionEvent[] = [];
  const nowSpent = new Set<string>();
  for (const event of events) {
    if (!SIGNIN_CARD_EVENT_TYPES.has(event.type)) continue;
    const flowId = signinFlowIdOf(event);
    // A flow that already had its turn goes, and is forgotten with it — nothing
    // accumulates across a long session.
    if (spent.has(flowId)) continue;
    kept.push(event);
    nowSpent.add(flowId);
  }
  return { kept, spentFlowIds: [...nowSpent] };
}

interface SessionStreamStoreState {
  sessions: Record<string, SessionStreamState>;
  sessionAccessOrder: string[];
  /**
   * The session id currently exempt from LRU eviction (DOR-298 PIP), or `null`
   * when nothing is pinned. See {@link SessionStreamActions.setPinnedSession}.
   */
  pinnedSessionId: string | null;
}

interface SessionStreamActions {
  /**
   * Hydrate a session from a cold-connect snapshot. Replaces messages, status,
   * and pending interactions, and sets both seq watermarks to the snapshot cursor.
   */
  applySnapshot: (sessionId: string, snapshot: SessionSnapshot) => void;
  /**
   * Apply a single live/replayed event. IDEMPOTENT: a no-op when
   * `event.seq <= lastAppliedSeq` (the no-dupes/no-gaps guarantee). Otherwise
   * folds the event into the projection and advances `lastAppliedSeq`.
   */
  applyEvent: (sessionId: string, event: SessionEvent) => void;
  /**
   * Set (or clear with `null`) the optimistic user message for a session. Held
   * until `turn_end` reconciliation reloads canonical history and clears it.
   */
  setOptimisticUserMessage: (
    sessionId: string,
    message: { id: string; content: string } | null
  ) => void;
  /**
   * Mark (or clear) a turn trigger as in flight for a session (CLI-B7). Set by
   * the submit path alongside the optimistic message; cleared automatically by
   * `turn_start`/`turn_end`, and manually on trigger failure or watchdog expiry.
   */
  setTriggerPending: (sessionId: string, pending: boolean) => void;
  /**
   * Move a session's client-only continuity state — the optimistic user message
   * and the trigger latch — to a new id, clearing the source. The
   * create-on-first-message rekey gives the SAME logical session a second id
   * (client UUID → canonical), and this state was authored by THIS client
   * against the old id, so it must follow the session rather than orphan.
   * Called from both rekey observation points: the 202 response
   * (`use-session-submit`) and the global stream's retire announce
   * (`session-stream-binding`).
   *
   * The QUEUE is deliberately not among the things that move: the server holds
   * it, follows the rekey itself, and re-announces it to whichever id the
   * window is watching. The source's PROJECTION (messages, in-progress turn,
   * seq watermark) is left intact for the same family of reason — each id-view
   * hydrates from its own `/events` snapshot, and a still-open retired-id view
   * keeps rendering until the URL rekeys. No-op when
   * `fromSessionId === toSessionId` or the source holds nothing.
   */
  migrateSessionContinuity: (fromSessionId: string, toSessionId: string) => void;
  /**
   * Replace a session's completed `messages` from a canonical history reload AND
   * clear `inProgressTurn` (without touching `status` or the seq watermark). Used
   * by the turn_end reconcile to persist the just-completed turn as full-fidelity
   * history: the reloaded `messages` now CONTAIN that turn, so the trailing
   * in-progress bubble must be dropped in the same update or the assistant reply
   * renders twice (history + bubble).
   *
   * Pass `preserveInProgressTurn: true` when a NEW turn started while the reload
   * was in flight (the reload predates it): clearing then would wipe the new
   * turn's already-streamed events, not the settled turn's.
   */
  setHistoryMessages: (
    sessionId: string,
    messages: HistoryMessage[],
    opts?: { preserveInProgressTurn?: boolean }
  ) => void;
  /** Update this session's durable-stream connection state. */
  setConnectionState: (sessionId: string, state: ConnectionState) => void;
  /** Remove a session's state entirely. */
  removeSession: (sessionId: string) => void;
  /** Ensure a default entry exists for an unknown id (returns nothing). */
  ensureSession: (sessionId: string) => void;
  /** Read a session's state, or {@link DEFAULT_SESSION_STREAM_STATE} for unknown ids. */
  getSession: (sessionId: string) => SessionStreamState;
  /**
   * Pin (or unpin with `null`) a session against LRU eviction (DOR-298 PIP): a
   * pinned session's entry survives {@link touchAndGet}'s eviction loop even
   * while idle, so a popped-out widget board never disappears just because the
   * operator switched the active session elsewhere. Set/cleared by the SAME
   * lifecycle that calls `streamManager.pinSession()`/`unpinSession()`
   * (`LiveSessionWidget`'s mount/unmount effect) — never call one without the
   * other, or store retention and stream liveness fall out of agreement.
   */
  setPinnedSession: (sessionId: string | null) => void;
}

/**
 * A fresh default session state. The arrays are fresh instances (not shared with
 * the module-level {@link DEFAULT_SESSION_STREAM_STATE}) so in-place mutation
 * under immer (e.g. `inProgressTurn.push`) can never freeze the shared constant.
 */
function freshSessionState(): SessionStreamState {
  return {
    ...DEFAULT_SESSION_STREAM_STATE,
    messages: [],
    queuedMessages: [],
    queueOutcomes: {},
    inProgressTurn: [],
    pendingInteractions: [],
  };
}

/** Get-or-init a session entry inside an immer producer, refreshing LRU order. */
function touchAndGet(state: SessionStreamStoreState, sessionId: string): SessionStreamState {
  if (!state.sessions[sessionId]) {
    state.sessions[sessionId] = freshSessionState();
  }
  const order = [sessionId, ...state.sessionAccessOrder.filter((id) => id !== sessionId)];
  for (const id of order.slice(MAX_RETAINED_SESSIONS)) {
    // Only evict idle sessions (no turn in progress) and never the pinned
    // session (DOR-298 PIP) — a pinned session showing a completed, non-
    // streaming widget board is exactly the idle-but-must-not-evict case.
    //
    // Queued messages used to pin a session here too (DOR-480): they were words
    // a person had typed that lived nowhere else, so eviction destroyed them.
    // The server holds the queue now, so everything in this entry is a derived
    // projection the next snapshot rebuilds — there is nothing left in here to
    // lose.
    const session = state.sessions[id];
    if (session && session.inProgressTurn.length === 0 && id !== state.pinnedSessionId) {
      delete state.sessions[id];
    }
  }
  state.sessionAccessOrder = order.filter((id) => id in state.sessions);
  return state.sessions[sessionId]!;
}

/**
 * Lifecycle to settle into when a live `turn_end` arrives. The success path emits
 * NO `status_change` carrying `lifecycle` (only `turn_end` with a `terminalReason`),
 * so the client must derive the settled lifecycle itself — otherwise it stays
 * `streaming` forever after a turn (blocking the next send and the reconcile).
 *
 * **A mirror of `deriveTurnEndLifecycle` in the server's
 * `session-state-projector.ts`, and it has to stay one.** One turn gets read
 * twice — live here, and from the server's snapshot on a cold hydrate — and the
 * two readings may not disagree, or a hard refresh would change what a session
 * says happened. The three predicates the rule turns on are imported from
 * `@dorkos/shared` for that reason rather than hand-copied; the interrupted set
 * WAS a hand-kept copy here until DOR-1676.
 *
 * The rule, in full, lives on the server method's docstring — including the two
 * limits it names, which apply here identically. In short: an already-held
 * `error` or the `error` reason settles `error`; an abort settles `interrupted`;
 * a reason that absolves settles idle; otherwise a latched error frame that is
 * not survivable settles `error`.
 *
 * The abort check knows SHAPE, never intent — the CLI collapses nine abort
 * causes into two strings — so an abort nobody asked for (an API refusal) reads
 * here as a stop. Read the server docstring's "known hole" section before
 * changing that ordering.
 *
 * `lastError` is the frame latch because it is the one that survives hydration:
 * it is cleared by every `turn_start` and set by every `error`, and it rides the
 * snapshot, so a client that hydrates mid-turn and then sees the live `turn_end`
 * lands on the server's answer instead of guessing from an empty local flag.
 *
 * @param current - The currently-held lifecycle (an `error` already set by an
 *   earlier `status_change` wins, matching the detached-error path).
 * @param terminalReason - The `turn_end`'s terminal reason, if carried.
 * @param lastError - The error frame this window latched, if any. Accepts
 *   `undefined` as well as `null`: the schema defaults it to `null`, but a
 *   status assembled from a partial `status_change` (or minted by a server that
 *   predates the field) simply has no key there, so a `!== null` test would read
 *   `.code` off nothing and throw inside the projection.
 * @param hasPendingInteractions - Whether interactions remain (→ `blocked`).
 */
function deriveTurnEndLifecycle(
  current: SessionLifecycle,
  terminalReason: string | undefined,
  lastError: TurnErrorEvent | null | undefined,
  hasPendingInteractions: boolean
): SessionLifecycle {
  if (current === 'error' || terminalReason === 'error') return 'error';
  if (isInterruptedTerminalReason(terminalReason)) return 'interrupted';
  const settled = hasPendingInteractions ? 'blocked' : 'idle';
  if (isAbsolvingTerminalReason(terminalReason)) return settled;
  if (lastError && !isNonFatalErrorCode(lastError.code)) return 'error';
  return settled;
}

/**
 * Re-derive `status.runningSubagentCount` from the two things that know: the
 * children this projection can name, and the ones the server counted before it
 * arrived.
 */
function syncRunningSubagentCount(session: SessionStreamState): void {
  if (!session.status) return;
  session.status.runningSubagentCount =
    session.runningSubagentIds.length + session.unnamedRunningSubagents;
}

/**
 * Fold one `subagent_update` into the session-level running set (DOR-1100).
 *
 * Mirrors the server projector's `applySubagentUpdate`, with one extra case it
 * does not need: a terminal update for an id this projection never saw start is
 * one of the {@link SessionStreamState.unnamedRunningSubagents} finishing, so it
 * decrements that instead of doing nothing. Without that arm, a session hydrated
 * mid-background-work would report those children as running forever.
 *
 * @param session - The session projection to mutate.
 * @param taskId - The child's runtime-assigned id.
 * @param status - Its reported lifecycle; only `running` is still in flight.
 *   Written as a negative check on the whole enum rather than a list of terminal
 *   values, so a status added later (`untracked`, DOR-1108) drains the count
 *   instead of silently pinning it.
 */
function applyRunningSubagent(
  session: SessionStreamState,
  taskId: string,
  status: BackgroundTaskStatus
): void {
  const known = session.runningSubagentIds.includes(taskId);
  if (status === 'running') {
    // Progress reports repeat `running` for a child already counted — adding it
    // again would inflate the tally with every tool the child uses.
    if (!known) session.runningSubagentIds.push(taskId);
  } else if (known) {
    session.runningSubagentIds = session.runningSubagentIds.filter((id) => id !== taskId);
  } else {
    session.unnamedRunningSubagents = Math.max(0, session.unnamedRunningSubagents - 1);
  }
  syncRunningSubagentCount(session);
}

/**
 * Name every child a snapshot's in-progress turn shows as still running.
 *
 * A snapshot carries the server's COUNT plus the current turn's events, so the
 * children of that turn can be named from the events and the rest cannot. The
 * caller books the difference as {@link SessionStreamState.unnamedRunningSubagents}.
 *
 * @param events - The snapshot's `inProgressTurn`, in seq order.
 */
function nameRunningSubagents(events: readonly SessionEvent[]): string[] {
  const byTask = new Map<string, boolean>();
  for (const event of events) {
    if (event.type !== 'subagent_update') continue;
    byTask.set(event.taskId, event.status === 'running');
  }
  return [...byTask].filter(([, running]) => running).map(([taskId]) => taskId);
}

/** Fold a single event into a session's projection (assumes seq already gated). */
function projectEvent(session: SessionStreamState, event: SessionEvent): void {
  switch (event.type) {
    case 'turn_start': {
      session.turnOrigin = event.origin === 'runtime' ? 'runtime' : 'user';
      if (event.origin !== 'runtime') session.userTurnCount += 1;
      if (event.origin === 'runtime') {
        // A window nobody asked for APPENDS. Resetting is right when a person
        // sends the next message — by then the settled turn has long since been
        // reloaded into `messages`. A wake-up is not that: the CLI drains its
        // queued notification within milliseconds, so this reopen routinely beats
        // the turn-end history reload, and resetting here blanked the reply the
        // agent had just finished writing until the reload landed. Appending
        // keeps it on screen, and the reload that follows replaces both windows
        // with canonical history in one update.
        //
        // No card aging either, for the same reason the server skips it: the
        // conversation has not moved on, the agent simply woke up (DOR-1004).
        session.inProgressTurn.push(event);
      } else {
        // A sign-in card (or its receipt) rides one turn further than the rest of
        // the turn it belonged to — see `ageSigninCards`.
        const aged = ageSigninCards(session.inProgressTurn, session.carriedSigninFlowIds);
        session.carriedSigninFlowIds = aged.spentFlowIds;
        session.inProgressTurn = [...aged.kept, event];
      }
      if (session.status) {
        session.status.lifecycle = 'streaming';
        // A new turn clears the previous failure surface (server-projector parity).
        session.status.lastError = null;
      }
      // The triggered turn materialized — the trigger window is over.
      session.triggerPending = false;
      break;
    }
    case 'turn_end':
      // Settle the lifecycle from the terminal reason — the success path carries
      // it on no other event, so without this the session stays `streaming`
      // forever (can't send again; the turn_end reconcile never fires). The turn's
      // events are KEPT (the trailing in-progress bubble keeps rendering) until the
      // reconcile reloads canonical history and clears them, or the next
      // turn_start/snapshot does.
      if (session.status) {
        session.status.lifecycle = deriveTurnEndLifecycle(
          session.status.lifecycle,
          event.terminalReason,
          session.status.lastError,
          session.pendingInteractions.length > 0
        );
        // A turn that did not settle to error leaves no stale failure behind
        // (a mid-turn error the runtime recovered from must not linger).
        if (session.status.lifecycle !== 'error') session.status.lastError = null;
      }
      // Stale-trigger safety: a settled turn means no trigger is in flight.
      session.triggerPending = false;
      break;
    case 'error':
      // Explicit case (not the TURN_EVENT_TYPES default arm): the event both
      // rides the turn — so the projection renders the inline error part — AND
      // mirrors into `status.lastError`, matching the server projector exactly.
      // Deliberately does NOT touch lifecycle: non-terminal errors exist, so
      // terminal settling stays owned by the turn_end derivation.
      session.inProgressTurn.push(event);
      if (session.status) {
        session.status.lastError = {
          message: event.message,
          ...(event.code !== undefined ? { code: event.code } : {}),
          ...(event.category !== undefined ? { category: event.category } : {}),
          ...(event.details !== undefined ? { details: event.details } : {}),
        };
      }
      break;
    case 'status_change':
      session.status = mergeStatus(session.status, event.status);
      break;
    case 'approval_required':
    case 'question_prompt':
    case 'elicitation_prompt': {
      const dto = interactionEventToDTO(event);
      const idx = session.pendingInteractions.findIndex((i) => i.id === dto.id);
      if (idx === -1) session.pendingInteractions.push(dto);
      else session.pendingInteractions[idx] = dto;
      break;
    }
    case 'mcp_signin_resolved':
      // The receipt is a NEW thing on screen and gets its own turn of grace,
      // whatever the card before it had already spent — the same reset the
      // server projector applies in `attachSigninResolution`.
      session.carriedSigninFlowIds = session.carriedSigninFlowIds.filter(
        (flowId) => flowId !== event.flowId
      );
      session.inProgressTurn.push(event);
      break;
    case 'interaction_resolved':
      // Drop the resolved DTO (no more pending card / countdown) AND record the
      // event in the turn so the pure projection can un-pend a part that was
      // folded from snapshot-carried interaction events (which this store never
      // saw as DTOs).
      session.pendingInteractions = session.pendingInteractions.filter((i) => i.id !== event.id);
      session.inProgressTurn.push(event);
      break;
    case 'queue_update': {
      // The whole queue, every time — never a diff. A window that missed an
      // update is corrected by the next one instead of drifting, which is why
      // there is no merge to get wrong here.
      session.queuedMessages = event.queue;
      const outcomes: Record<string, MessageDeliveryOutcome> = {};
      for (const queued of event.queue) {
        const kept = session.queueOutcomes[queued.id];
        if (kept) outcomes[queued.id] = kept;
      }
      // An outcome only rides an update an accepted message caused, so it names
      // a message that just joined the queue — or one that ran straight away and
      // is therefore already absent from it.
      if (event.outcome && event.queue.some((queued) => queued.id === event.outcome?.messageId)) {
        outcomes[event.outcome.messageId] = event.outcome;
      }
      session.queueOutcomes = outcomes;
      break;
    }
    case 'subagent_update':
      // Explicit case rather than the default arm: the event both rides the turn
      // — so the turn's own subagent fold still draws it — AND maintains the
      // session-level running set, which is the only reading that survives the
      // turn it started in (DOR-1100). Server-projector parity: the same
      // add-on-running / drop-on-terminal rule `applySubagentUpdate` applies.
      session.inProgressTurn.push(event);
      applyRunningSubagent(session, event.taskId, event.status);
      break;
    default:
      if (TURN_EVENT_TYPES.has(event.type)) session.inProgressTurn.push(event);
      break;
  }
  // Applied here rather than at the `turn_start` that starts a window, because
  // the growth is the DELTAS: bounding only at the boundary let the newest
  // window overshoot by its whole length. The length check is the fast path, so
  // every ordinary turn pays one comparison and nothing else.
  if (session.inProgressTurn.length > MAX_LIVE_TURN_EVENTS) {
    session.inProgressTurn = boundLiveTurn(session.inProgressTurn);
  }
  session.lastAppliedSeq = event.seq;
  session.lastEventAt = Date.now();
}

/**
 * The bound store type, written out explicitly. Without this annotation tsc
 * infers a type that reaches into immer's non-exported `WritableNonArrayDraft`
 * and fails declaration emit with TS4023 ("...but cannot be named") whenever the
 * surrounding program's type graph makes it try — an explicit, fully nameable
 * type keeps the export portable regardless of what else the program imports.
 */
type SessionStreamStore = UseBoundStore<
  Mutate<
    StoreApi<SessionStreamStoreState & SessionStreamActions>,
    [['zustand/devtools', never], ['zustand/immer', never]]
  >
>;

/**
 * Zustand store for the per-session stream projection.
 *
 * Decoupled from the React lifecycle so sessions hydrate once and survive
 * switches; the StreamManager feeds it via the binding.
 */
export const useSessionStreamStore: SessionStreamStore = create<
  SessionStreamStoreState & SessionStreamActions
>()(
  devtools(
    immer((set, get) => ({
      sessions: {},
      sessionAccessOrder: [],
      pinnedSessionId: null,

      applySnapshot: (sessionId, snapshot) =>
        set(
          (state) => {
            const session = touchAndGet(state, sessionId);
            session.messages = snapshot.messages;
            session.status = snapshot.status;
            session.pendingInteractions = snapshot.pendingInteractions;
            session.inProgressTurn = snapshot.inProgressTurn ?? [];
            // Hydration replaces the queue wholesale — that is what makes it
            // survive a refresh and show up in a window that just opened. The
            // receipts do not survive: they belong to an acceptance this window
            // was not necessarily present for, and the queue is what matters.
            session.queuedMessages = snapshot.queuedMessages;
            session.queueOutcomes = {};
            // The server sends only the sign-in cards it is still carrying, so its
            // answer replaces this projection's grace bookkeeping wholesale
            // (DOR-1004). Keeping stale marks would retire a card the server just
            // said is on screen.
            //
            // The snapshot carries no grace bookkeeping of its own — the server
            // holds that privately — so a reconnect DURING a card's grace turn
            // deliberately re-baselines it and the card gets that turn again. The
            // skew is bounded at one turn and self-heals on the next `turn_start`,
            // which is the right trade: the alternative is trusting a mark the
            // authority never sent, and erasing a live card is worse than showing
            // a finished one a turn longer.
            session.carriedSigninFlowIds = [];
            // Re-baseline the live-children set against the server's own answer
            // (DOR-1100). The snapshot names the current turn's children and
            // counts all of them, so anything the count covers and the events do
            // not is a child from an earlier turn — still running, still worth
            // reporting, just not nameable from here.
            session.runningSubagentIds = nameRunningSubagents(session.inProgressTurn);
            session.unnamedRunningSubagents = Math.max(
              0,
              snapshot.status.runningSubagentCount - session.runningSubagentIds.length
            );
            // Re-assign rather than mutate: the caller's snapshot object is
            // frozen, and the two parts must add back up to the count anyway.
            // They do today by construction; this keeps them agreeing if the
            // clamp above ever has to bite (a snapshot whose count is lower
            // than the children its own turn shows running). Copying also stops
            // the store aliasing an object it does not own.
            session.status = {
              ...snapshot.status,
              runningSubagentCount:
                session.runningSubagentIds.length + session.unnamedRunningSubagents,
            };
            session.lastAppliedSeq = snapshot.cursor;
            session.lastEventAt = Date.now();
            session.streamReadyCursor = snapshot.cursor;
            // Marks every lifecycle value the snapshot carries as hydration, not
            // a live transition (the turn-end reconcile re-baselines on this).
            session.hydrationGeneration += 1;
            // A snapshot whose history already ends with the optimistic message
            // means the send was persisted server-side before this (re)connect —
            // e.g. a mid-turn reconnect, where the user message is written at turn
            // start. Keeping the optimistic copy would render the message twice
            // until the turn settles. Content-compare is best-effort (a
            // transformContent send won't match and self-heals at settle).
            const optimistic = session.optimisticUserMessage;
            if (optimistic) {
              const lastUser = [...snapshot.messages].reverse().find((m) => m.role === 'user');
              if (lastUser && lastUser.content === optimistic.content) {
                session.optimisticUserMessage = null;
              }
            }
          },
          false,
          'session-stream/applySnapshot'
        ),

      applyEvent: (sessionId, event) =>
        set(
          (state) => {
            // Idempotency guard runs BEFORE any LRU mutation: a duplicate /
            // gap-replayed event (common after a reconnect that replays an
            // already-seen gap) must not churn `sessionAccessOrder` or evict idle
            // siblings via `touchAndGet`. The watermark for an unknown session is
            // the default `lastAppliedSeq` (0), so `seq <= 0` stays a no-op while
            // the first real event of a new session still applies.
            const existing = state.sessions[sessionId];
            const watermark =
              existing?.lastAppliedSeq ?? DEFAULT_SESSION_STREAM_STATE.lastAppliedSeq;
            if (event.seq <= watermark) return; // idempotent no-op
            const session = touchAndGet(state, sessionId);
            projectEvent(session, event);
          },
          false,
          'session-stream/applyEvent'
        ),

      setOptimisticUserMessage: (sessionId, message) =>
        set(
          (state) => {
            const session = touchAndGet(state, sessionId);
            session.optimisticUserMessage = message;
          },
          false,
          'session-stream/setOptimisticUserMessage'
        ),

      setTriggerPending: (sessionId, pending) =>
        set(
          (state) => {
            const session = touchAndGet(state, sessionId);
            session.triggerPending = pending;
          },
          false,
          'session-stream/setTriggerPending'
        ),

      migrateSessionContinuity: (fromSessionId, toSessionId) =>
        set(
          (state) => {
            if (fromSessionId === toSessionId) return;
            const source = state.sessions[fromSessionId];
            if (!source) return;
            const hasContinuity = source.optimisticUserMessage !== null || source.triggerPending;
            if (!hasContinuity) return;
            const target = touchAndGet(state, toSessionId);
            // The optimistic message moves only when the target has none — a
            // target-side optimistic (e.g. a send already re-keyed by the 202
            // path) is newer and wins.
            if (source.optimisticUserMessage && !target.optimisticUserMessage) {
              target.optimisticUserMessage = source.optimisticUserMessage;
            }
            source.optimisticUserMessage = null;
            // The trigger latch follows the canonical id (its turn_start
            // streams under the canonical session); the retired id's releases.
            if (source.triggerPending) target.triggerPending = true;
            source.triggerPending = false;
          },
          false,
          'session-stream/migrateSessionContinuity'
        ),

      setHistoryMessages: (sessionId, messages, opts) =>
        set(
          (state) => {
            const session = touchAndGet(state, sessionId);
            session.messages = messages;
            // The reloaded history now carries the just-completed turn, so drop the
            // trailing in-progress bubble to avoid rendering the reply twice —
            // unless the bubble already belongs to a NEWER turn the reload predates.
            // An unresolved sign-in card survives either way: history has no record
            // of it and the person is still mid-sign-in (DOR-1004).
            session.inProgressTurn = opts?.preserveInProgressTurn
              ? // A newer window is open, so keep it — but only IT. See
                // `retainCurrentWindow`: after a wake-up the turn also holds the
                // window this reload just supplied as history.
                retainCurrentWindow(session.inProgressTurn)
              : retainOpenSigninCards(session.inProgressTurn);
          },
          false,
          'session-stream/setHistoryMessages'
        ),

      setConnectionState: (sessionId, connectionState) =>
        set(
          (state) => {
            const session = touchAndGet(state, sessionId);
            session.connectionState = connectionState;
          },
          false,
          'session-stream/setConnectionState'
        ),

      removeSession: (sessionId) =>
        set(
          (state) => {
            delete state.sessions[sessionId];
            state.sessionAccessOrder = state.sessionAccessOrder.filter((id) => id !== sessionId);
          },
          false,
          'session-stream/removeSession'
        ),

      ensureSession: (sessionId) =>
        set(
          (state) => {
            touchAndGet(state, sessionId);
          },
          false,
          'session-stream/ensureSession'
        ),

      getSession: (sessionId) => get().sessions[sessionId] ?? DEFAULT_SESSION_STREAM_STATE,

      setPinnedSession: (sessionId) =>
        set(
          (state) => {
            state.pinnedSessionId = sessionId;
          },
          false,
          'session-stream/setPinnedSession'
        ),
    })),
    { name: 'SessionStreamStore', enabled: import.meta.env.DEV }
  )
);

/** Session-scoped selector — re-renders only when this session's state changes. */
export function useSessionStreamState(sessionId: string): SessionStreamState {
  return useSessionStreamStore(
    useCallback((s) => s.sessions[sessionId] ?? DEFAULT_SESSION_STREAM_STATE, [sessionId])
  );
}

/** Granular selector: the held status for a session. */
export function useSessionStreamStatus(sessionId: string): SessionStatus | null {
  return useSessionStreamStore(
    useCallback((s) => s.sessions[sessionId]?.status ?? null, [sessionId])
  );
}

/**
 * Granular selector: the server-projected lifecycle, or `undefined` before the
 * first hydration. Subscribing to the discriminant alone (rather than the whole
 * status object) keeps a readout from re-rendering on every token-count delta.
 */
export function useSessionStreamLifecycle(sessionId: string): SessionLifecycle | undefined {
  return useSessionStreamStore(
    useCallback((s) => s.sessions[sessionId]?.status?.lifecycle, [sessionId])
  );
}

/**
 * Granular selector: whether a message sent now could CUT INTO this session's
 * live turn, or `undefined` when the server has given no per-session answer.
 *
 * `undefined` means "fall back to the runtime's static `supportsSteer`" — the
 * shape the server's own field carries (DOR-1268). It is deliberately not
 * collapsed to `false` here: a runtime whose steering is uniform across its
 * sessions never sets the field, and reading its silence as "no" would hide a
 * capability that works.
 */
export function useSessionSteerable(sessionId: string): boolean | undefined {
  return useSessionStreamStore(
    useCallback((s) => s.sessions[sessionId]?.status?.steerable, [sessionId])
  );
}

/**
 * Granular selector: whether this session is waiting on a decision from the
 * operator — a `blocked` lifecycle, or any pending interaction still on screen.
 *
 * This is the AUTHORITATIVE answer, which the coarse rendered status cannot give:
 * `selectRenderedStatus` deliberately collapses `blocked` → `idle` because the
 * renderer expresses blocking through the interaction cards instead. Anything
 * that must not treat a blocked session as ready for a new turn — the queue's
 * auto-flush above all, since the server keeps the turn's session lock for the
 * whole time it is blocked (DOR-480) — has to read this rather than the
 * projection meant for display.
 */
export function useSessionAwaitingDecision(sessionId: string): boolean {
  return useSessionStreamStore(
    useCallback(
      (s) => {
        const session = s.sessions[sessionId];
        if (!session) return false;
        return session.status?.lifecycle === 'blocked' || session.pendingInteractions.length > 0;
      },
      [sessionId]
    )
  );
}

/** Granular selector: this session's durable-stream connection state. */
export function useSessionStreamConnection(sessionId: string): ConnectionState {
  return useSessionStreamStore(
    useCallback((s) => s.sessions[sessionId]?.connectionState ?? 'connecting', [sessionId])
  );
}

/**
 * Granular selector: the highest `seq` applied from this session's durable
 * stream. `0` before the first hydration. Diagnostics-only — it answers "how far
 * has this client actually caught up?" when a stream is misbehaving.
 */
export function useSessionLastEventSeq(sessionId: string): number {
  return useSessionStreamStore(
    useCallback((s) => s.sessions[sessionId]?.lastAppliedSeq ?? 0, [sessionId])
  );
}

/**
 * Granular selector: when this session last applied a frame, or `null` before
 * the first hydration. Pairs with {@link useSessionStreamConnection} — see
 * {@link SessionStreamState.lastEventAt} for why "connected but silent" matters.
 */
export function useSessionLastEventAt(sessionId: string): number | null {
  return useSessionStreamStore(
    useCallback((s) => s.sessions[sessionId]?.lastEventAt ?? null, [sessionId])
  );
}

/**
 * Granular selector: the cursor of the most recent snapshot this session
 * hydrated from — the point live replay resumed at. `null` before the first
 * hydration. Diagnostics-only: read beside `lastAppliedSeq` it says whether the
 * client has advanced at all since it (re)connected.
 */
export function useSessionSnapshotCursor(sessionId: string): number | null {
  return useSessionStreamStore(
    useCallback((s) => s.sessions[sessionId]?.streamReadyCursor ?? null, [sessionId])
  );
}

/**
 * Granular selector: whether a turn trigger is in flight for this session (the
 * POST has been sent, the server's `turn_start` has not arrived). A latch stuck
 * on is a stalled trigger, which is why the readout shows it.
 */
export function useSessionTriggerPending(sessionId: string): boolean {
  return useSessionStreamStore(
    useCallback((s) => s.sessions[sessionId]?.triggerPending ?? false, [sessionId])
  );
}

/** Stable empty turn so unknown sessions return a referentially-stable value. */
const EMPTY_TURN: SessionEvent[] = [];

/**
 * Granular selector: the events of the turn in progress, empty when the session
 * is idle. Consumed by the session readout's live subagent fold.
 */
export function useSessionInProgressTurn(sessionId: string): SessionEvent[] {
  return useSessionStreamStore(
    useCallback((s) => s.sessions[sessionId]?.inProgressTurn ?? EMPTY_TURN, [sessionId])
  );
}

/** Stable empty queue so unknown sessions return a referentially-stable value. */
const EMPTY_QUEUE: QueuedMessage[] = [];

/** Stable empty receipt map, for the same reason as {@link EMPTY_QUEUE}. */
const EMPTY_QUEUE_OUTCOMES: Record<string, MessageDeliveryOutcome> = {};

/** Granular selector: the messages waiting behind this session's running turn. */
export function useSessionQueue(sessionId: string): QueuedMessage[] {
  return useSessionStreamStore(
    useCallback((s) => s.sessions[sessionId]?.queuedMessages ?? EMPTY_QUEUE, [sessionId])
  );
}

/** Granular selector: the delivery receipts of this session's waiting messages. */
export function useSessionQueueOutcomes(sessionId: string): Record<string, MessageDeliveryOutcome> {
  return useSessionStreamStore(
    useCallback((s) => s.sessions[sessionId]?.queueOutcomes ?? EMPTY_QUEUE_OUTCOMES, [sessionId])
  );
}
