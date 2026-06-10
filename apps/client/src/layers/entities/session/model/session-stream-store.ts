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
} from '@dorkos/shared/session-stream';

/** Maximum number of sessions retained before LRU eviction (mirrors the chat store). */
const MAX_RETAINED_SESSIONS = 20;

/**
 * Client-side projection of a single session's server state, hydrated from a
 * {@link SessionSnapshot} and advanced by {@link SessionEvent}s.
 */
export interface SessionStreamState {
  /** Completed message history for the session (from the snapshot). */
  messages: HistoryMessage[];
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
}

/** Default state for an un-hydrated session. */
export const DEFAULT_SESSION_STREAM_STATE: SessionStreamState = {
  messages: [],
  inProgressTurn: [],
  status: null,
  pendingInteractions: [],
  lastAppliedSeq: 0,
  streamReadyCursor: null,
  connectionState: 'connecting',
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
  'tool_call',
  'tool_result',
  'subagent_update',
  'todo_update',
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
  /** Update this session's durable-stream connection state. */
  setConnectionState: (sessionId: string, state: ConnectionState) => void;
  /** Remove a session's state entirely. */
  removeSession: (sessionId: string) => void;
  /** Ensure a default entry exists for an unknown id (returns nothing). */
  ensureSession: (sessionId: string) => void;
  /** Read a session's state, or {@link DEFAULT_SESSION_STREAM_STATE} for unknown ids. */
  getSession: (sessionId: string) => SessionStreamState;
}

/** Get-or-init a session entry inside an immer producer, refreshing LRU order. */
function touchAndGet(state: SessionStreamStoreState, sessionId: string): SessionStreamState {
  if (!state.sessions[sessionId]) {
    state.sessions[sessionId] = { ...DEFAULT_SESSION_STREAM_STATE };
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

/** Fold a single event into a session's projection (assumes seq already gated). */
function projectEvent(session: SessionStreamState, event: SessionEvent): void {
  switch (event.type) {
    case 'turn_start':
      session.inProgressTurn = [event];
      if (session.status) session.status.lifecycle = 'streaming';
      break;
    case 'turn_end':
      // Keep the turn — it is cleared on the next turn_start or snapshot.
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
