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
 * forward every validated frame without dedup.
 *
 * This module is pure state — it imports NOTHING from the StreamManager. The
 * binding (`session-stream-binding.ts`) wires the two together so the
 * entities→shared dependency direction stays one-way (FSD).
 *
 * @module entities/session/model/session-stream-store
 */
import { useCallback } from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { ConnectionState, HistoryMessage, PendingInteractionDTO } from '@dorkos/shared/types';
import type {
  SessionEvent,
  SessionStatus,
  SessionSnapshot,
  SessionContextUsage,
  SessionLifecycle,
} from '@dorkos/shared/session-stream';

/** Maximum number of sessions retained before LRU eviction (mirrors the chat store). */
const MAX_RETAINED_SESSIONS = 20;

/**
 * A single message composed-and-queued while the agent was streaming, awaiting
 * auto-flush on the streaming→idle edge. Stored per session (keyed by the store
 * `sessions` map) so a message queued in session A can never flush into session
 * B after a switch (DOR-81). The `id` gives QueuePanel stable React keys and lets
 * the flush dequeue the exact item it sent.
 */
export interface QueuedMessage {
  id: string;
  content: string;
}

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
   * Messages composed-and-queued while this session was streaming (DOR-81),
   * FIFO. Auto-flushed one-at-a-time on the streaming→idle edge by the chat
   * queue hook. Keyed per session here so a queue can only ever flush into the
   * session it was composed in — a session switch cannot misdeliver it.
   */
  queuedMessages: QueuedMessage[];
  /** Events of the turn in progress; empty when the session is idle. */
  inProgressTurn: SessionEvent[];
  /** Server-held status projection, or `null` before the first hydration. */
  status: SessionStatus | null;
  /** Pending interactions awaiting the operator (ADR-0262), keyed by `id`. */
  pendingInteractions: PendingInteractionDTO[];
  /** Highest `seq` applied so far; the idempotency/gap-free watermark. */
  lastAppliedSeq: number;
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
}

/** Default state for an un-hydrated session. */
export const DEFAULT_SESSION_STREAM_STATE: SessionStreamState = {
  messages: [],
  optimisticUserMessage: null,
  queuedMessages: [],
  inProgressTurn: [],
  status: null,
  pendingInteractions: [],
  lastAppliedSeq: 0,
  streamReadyCursor: null,
  connectionState: 'connecting',
  triggerPending: false,
  hydrationGeneration: 0,
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
]);

interface SessionStreamStoreState {
  sessions: Record<string, SessionStreamState>;
  sessionAccessOrder: string[];
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
  /** Append a composed-while-streaming message to a session's flush queue (DOR-81). */
  enqueueMessage: (sessionId: string, content: string) => void;
  /** Replace a queued message's content in place (queue editing). */
  updateQueuedMessage: (sessionId: string, id: string, content: string) => void;
  /** Remove a single queued message by id (after flush or operator removal). */
  removeQueuedMessage: (sessionId: string, id: string) => void;
  /** Clear a session's entire flush queue. */
  clearQueue: (sessionId: string) => void;
  /**
   * Move a session's queued messages to a new id, preserving order, and clear
   * the source. Mirrors the create-on-first-message rekey so a message queued
   * under the client UUID survives the client-uuid → canonical-id swap (DOR-81 /
   * DOR-74). No-op when `fromSessionId === toSessionId`.
   */
  moveQueue: (fromSessionId: string, toSessionId: string) => void;
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
}

/**
 * A fresh default session state. The arrays are fresh instances (not shared with
 * the module-level {@link DEFAULT_SESSION_STREAM_STATE}) so in-place mutation
 * under immer (e.g. `queuedMessages.push`) can never freeze the shared constant.
 */
function freshSessionState(): SessionStreamState {
  return {
    ...DEFAULT_SESSION_STREAM_STATE,
    messages: [],
    queuedMessages: [],
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
    // Only evict idle sessions (no turn in progress) to avoid dropping live state.
    if (state.sessions[id] && state.sessions[id]!.inProgressTurn.length === 0) {
      delete state.sessions[id];
    }
  }
  state.sessionAccessOrder = order.filter((id) => id in state.sessions);
  return state.sessions[sessionId]!;
}

/**
 * `turn_end.terminalReason` values meaning the turn was interrupted/aborted
 * rather than completing normally. Mirrors the server projector's
 * `INTERRUPTED_TERMINAL_REASONS` so a client observing a live `turn_end` settles
 * to the SAME lifecycle the server's snapshot would.
 */
const INTERRUPTED_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'interrupted',
  'aborted_streaming',
  'aborted_tools',
]);

/**
 * Lifecycle to settle into when a live `turn_end` arrives. The success path emits
 * NO `status_change` carrying `lifecycle` (only `turn_end` with a `terminalReason`),
 * so the client must derive the settled lifecycle itself — otherwise it stays
 * `streaming` forever after a turn (blocking the next send and the reconcile).
 * Mirrors `deriveTurnEndLifecycle` in `session-state-projector.ts`.
 *
 * @param current - The currently-held lifecycle (an `error` already set by an
 *   earlier `status_change` wins, matching the detached-error path).
 * @param terminalReason - The `turn_end`'s terminal reason, if carried.
 * @param hasPendingInteractions - Whether interactions remain (→ `blocked`).
 */
function deriveTurnEndLifecycle(
  current: SessionLifecycle,
  terminalReason: string | undefined,
  hasPendingInteractions: boolean
): SessionLifecycle {
  if (current === 'error' || terminalReason === 'error') return 'error';
  if (terminalReason !== undefined && INTERRUPTED_TERMINAL_REASONS.has(terminalReason)) {
    return 'interrupted';
  }
  return hasPendingInteractions ? 'blocked' : 'idle';
}

/** Fold a single event into a session's projection (assumes seq already gated). */
function projectEvent(session: SessionStreamState, event: SessionEvent): void {
  switch (event.type) {
    case 'turn_start':
      session.inProgressTurn = [event];
      if (session.status) session.status.lifecycle = 'streaming';
      // The triggered turn materialized — the trigger window is over.
      session.triggerPending = false;
      break;
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
          session.pendingInteractions.length > 0
        );
      }
      // Stale-trigger safety: a settled turn means no trigger is in flight.
      session.triggerPending = false;
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
    case 'interaction_resolved':
      // Drop the resolved DTO (no more pending card / countdown) AND record the
      // event in the turn so the pure projection can un-pend a part that was
      // folded from snapshot-carried interaction events (which this store never
      // saw as DTOs).
      session.pendingInteractions = session.pendingInteractions.filter((i) => i.id !== event.id);
      session.inProgressTurn.push(event);
      break;
    default:
      if (TURN_EVENT_TYPES.has(event.type)) session.inProgressTurn.push(event);
      break;
  }
  session.lastAppliedSeq = event.seq;
}

/**
 * Zustand store for the per-session stream projection.
 *
 * Decoupled from the React lifecycle so sessions hydrate once and survive
 * switches; the StreamManager feeds it via the binding.
 */
export const useSessionStreamStore = create<SessionStreamStoreState & SessionStreamActions>()(
  devtools(
    immer((set, get) => ({
      sessions: {},
      sessionAccessOrder: [],

      applySnapshot: (sessionId, snapshot) =>
        set(
          (state) => {
            const session = touchAndGet(state, sessionId);
            session.messages = snapshot.messages;
            session.status = snapshot.status;
            session.pendingInteractions = snapshot.pendingInteractions;
            session.inProgressTurn = snapshot.inProgressTurn ?? [];
            session.lastAppliedSeq = snapshot.cursor;
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

      enqueueMessage: (sessionId, content) =>
        set(
          (state) => {
            const session = touchAndGet(state, sessionId);
            session.queuedMessages.push({ id: crypto.randomUUID(), content });
          },
          false,
          'session-stream/enqueueMessage'
        ),

      updateQueuedMessage: (sessionId, id, content) =>
        set(
          (state) => {
            const session = touchAndGet(state, sessionId);
            const item = session.queuedMessages.find((m) => m.id === id);
            if (item) item.content = content;
          },
          false,
          'session-stream/updateQueuedMessage'
        ),

      removeQueuedMessage: (sessionId, id) =>
        set(
          (state) => {
            const session = touchAndGet(state, sessionId);
            session.queuedMessages = session.queuedMessages.filter((m) => m.id !== id);
          },
          false,
          'session-stream/removeQueuedMessage'
        ),

      clearQueue: (sessionId) =>
        set(
          (state) => {
            const session = touchAndGet(state, sessionId);
            session.queuedMessages = [];
          },
          false,
          'session-stream/clearQueue'
        ),

      moveQueue: (fromSessionId, toSessionId) =>
        set(
          (state) => {
            if (fromSessionId === toSessionId) return;
            const source = state.sessions[fromSessionId];
            if (!source || source.queuedMessages.length === 0) return;
            const target = touchAndGet(state, toSessionId);
            target.queuedMessages = source.queuedMessages;
            source.queuedMessages = [];
          },
          false,
          'session-stream/moveQueue'
        ),

      setHistoryMessages: (sessionId, messages, opts) =>
        set(
          (state) => {
            const session = touchAndGet(state, sessionId);
            session.messages = messages;
            // The reloaded history now carries the just-completed turn, so drop the
            // trailing in-progress bubble to avoid rendering the reply twice —
            // unless the bubble already belongs to a NEWER turn the reload predates.
            if (!opts?.preserveInProgressTurn) {
              session.inProgressTurn = [];
            }
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

/** Granular selector: this session's durable-stream connection state. */
export function useSessionStreamConnection(sessionId: string): ConnectionState {
  return useSessionStreamStore(
    useCallback((s) => s.sessions[sessionId]?.connectionState ?? 'connecting', [sessionId])
  );
}

/** Stable empty queue so unknown sessions return a referentially-stable value. */
const EMPTY_QUEUE: QueuedMessage[] = [];

/** Granular selector: this session's composed-while-streaming flush queue (DOR-81). */
export function useSessionQueue(sessionId: string): QueuedMessage[] {
  return useSessionStreamStore(
    useCallback((s) => s.sessions[sessionId]?.queuedMessages ?? EMPTY_QUEUE, [sessionId])
  );
}
