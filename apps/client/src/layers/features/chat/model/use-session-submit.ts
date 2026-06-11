/**
 * Submission and stop logic for a single chat session under the trigger-only
 * POST contract (spec chat-stream-reconnection, Phase 5 / DOR-74).
 *
 * `POST /sessions/:id/messages` is now a `202` trigger that resolves to the
 * SDK-canonical session id; the turn itself streams over the durable `/events`
 * stream (snapshot → replay → live) consumed by the shared {@link streamManager}
 * → per-session stream store. This hook therefore:
 *
 * 1. Holds the just-sent message as an OPTIMISTIC user message in the stream
 *    store (the `/events` contract carries no user-message event, and the
 *    snapshot predates the send), so it renders immediately.
 * 2. Ensures the durable stream is attached to the target session BEFORE the
 *    POST (subscribe-first), then triggers the turn.
 * 3. On a canonical-id rekey (create-on-first-message), re-targets the durable
 *    stream, rewrites the URL in place, and moves the optimistic message +
 *    optimistic session-cache entry to the canonical id.
 *
 * Turn-end reconciliation (reload canonical history, clear the optimistic
 * message) lives in {@link useTurnEndReconcile}, keyed off the stream store's
 * streaming→idle transition.
 *
 * @module features/chat/model/use-session-submit
 */
import { useCallback, useEffect, useRef } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { Session } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';
import { TIMING } from '@/layers/shared/lib';
import { streamManager } from '@/layers/shared/lib/transport';
import { insertOptimisticSession, useSessionStreamStore } from '@/layers/entities/session';
import type { SessionStoreActions } from './use-session-store-actions';
import type { ChatSessionOptions, ChatStatus } from './chat-types';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

interface UseSessionSubmitParams {
  sessionId: string | null;
  input: string;
  status: ChatStatus;
  transport: ReturnType<typeof useTransport>;
  queryClient: QueryClient;
  selectedCwd: string | null;
  // Option callbacks from ChatSessionOptions
  onSessionIdChangeReplace: ChatSessionOptions['onSessionIdChangeReplace'];
  transformContent: ChatSessionOptions['transformContent'];
  // Store setters (sourced from useSessionStoreActions)
  setInput: SessionStoreActions['setInput'];
  setError: SessionStoreActions['setError'];
  setSessionBusy: SessionStoreActions['setSessionBusy'];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Submission and stop callbacks for a chat session (trigger-only POST → `/events`).
 *
 * @returns Stable callbacks for the UI layer.
 */
export function useSessionSubmit({
  sessionId,
  input,
  status,
  transport,
  queryClient,
  selectedCwd,
  onSessionIdChangeReplace,
  transformContent,
  setInput,
  setError,
  setSessionBusy,
}: UseSessionSubmitParams) {
  // Refs to avoid stale closures inside the async submit callback.
  const selectedCwdRef = useRef(selectedCwd);
  useEffect(() => {
    selectedCwdRef.current = selectedCwd;
  }, [selectedCwd]);

  const transformContentRef = useRef(transformContent);
  useEffect(() => {
    transformContentRef.current = transformContent;
  });

  const onSessionIdChangeReplaceRef = useRef(onSessionIdChangeReplace);
  useEffect(() => {
    onSessionIdChangeReplaceRef.current = onSessionIdChangeReplace;
  });

  const sessionBusyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (sessionBusyTimerRef.current) clearTimeout(sessionBusyTimerRef.current);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Submission
  // ---------------------------------------------------------------------------

  /**
   * Core submission logic shared by `handleSubmit` and `submitContent`.
   *
   * @param content - The trimmed message text to send.
   * @param clearInput - When true, clears the input state after triggering.
   * @param restoreContentOnLock - Content to restore if the session is locked.
   */
  const executeSubmission = useCallback(
    async (content: string, clearInput: boolean, restoreContentOnLock: string) => {
      const targetSessionId = sessionId!;
      const cwd = selectedCwdRef.current;
      const streamStore = useSessionStreamStore.getState();

      // Optimistically insert a placeholder session if not yet in the cache so
      // the sidebar shows the new conversation immediately.
      const sessions = queryClient.getQueryData<Session[]>(['sessions', cwd]) ?? [];
      if (!sessions.some((s) => s.id === targetSessionId)) {
        const now = new Date().toISOString();
        insertOptimisticSession(queryClient, cwd, {
          id: targetSessionId,
          title: `Session ${targetSessionId.slice(0, 8)}`,
          createdAt: now,
          updatedAt: now,
          permissionMode: 'default',
        });
      }

      // Show the user's message immediately — it is NOT in the (pre-send)
      // snapshot and the /events stream carries no user-message event.
      const optimisticId = crypto.randomUUID();
      streamStore.setOptimisticUserMessage(targetSessionId, { id: optimisticId, content });
      // Latch the trigger window (CLI-B7): the rendered status reads `streaming`
      // from this moment, so a second Enter during the POST round-trip queues
      // instead of double-submitting. turn_start clears it.
      streamStore.setTriggerPending(targetSessionId, true);

      if (clearInput) setInput('');
      setError(null);

      // Subscribe-first: ensure the durable stream is attached BEFORE the POST so
      // the turn's first frames (turn_start, deltas) are never missed. Idempotent
      // on the already-attached session+cwd.
      streamManager.attachSession(targetSessionId, cwd);

      try {
        const finalContent = transformContentRef.current
          ? await transformContentRef.current(content)
          : content;

        const { sessionId: canonicalId } = await transport.postMessage(
          targetSessionId,
          finalContent,
          cwd ?? undefined,
          { clientMessageId: optimisticId }
        );

        // Create-on-first-message rekey: the SDK assigned a different canonical
        // id. Re-target the durable stream, move the optimistic state to the new
        // key, drop the stale entry, and rewrite the URL in place.
        if (canonicalId !== targetSessionId) {
          streamManager.attachSession(canonicalId, cwd);
          const store = useSessionStreamStore.getState();
          store.setOptimisticUserMessage(canonicalId, { id: optimisticId, content });
          store.setOptimisticUserMessage(targetSessionId, null);
          // The trigger latch follows the canonical id (its turn_start streams
          // under the canonical session); release the throwaway client UUID's.
          store.setTriggerPending(canonicalId, true);
          store.setTriggerPending(targetSessionId, false);
          // Move any compose-next queue from the throwaway client UUID to the
          // canonical id so a message queued during the first turn still flushes
          // to the (now-canonical) same logical session (DOR-81 / DOR-74).
          store.moveQueue(targetSessionId, canonicalId);

          const cachedSessions = queryClient.getQueryData<Session[]>(['sessions', cwd]) ?? [];
          const optimisticEntry = cachedSessions.find((s) => s.id === targetSessionId);
          if (optimisticEntry && !cachedSessions.some((s) => s.id === canonicalId)) {
            insertOptimisticSession(queryClient, cwd, { ...optimisticEntry, id: canonicalId });
          }
          // Drop the stale client-UUID row — without this the sidebar shows a
          // ghost duplicate ("Session xxxxxxxx" pointing at a dead id) until the
          // next list refetch, which no longer happens on a timer.
          queryClient.setQueryData<Session[]>(['sessions', cwd], (prev) =>
            prev?.filter((s) => s.id !== targetSessionId)
          );

          onSessionIdChangeReplaceRef.current?.(canonicalId);
        }

        // Watchdog: a 202 whose turn never materializes (server dropped it)
        // must not wedge the composer in queue mode — release the latch if no
        // turn_start arrived in time. One-shot, reads live state when it fires,
        // and is a no-op when the turn started (or a newer send re-latched).
        const latchedId = canonicalId;
        setTimeout(() => {
          const session = useSessionStreamStore.getState().getSession(latchedId);
          if (session.triggerPending && session.status?.lifecycle !== 'streaming') {
            useSessionStreamStore.getState().setTriggerPending(latchedId, false);
          }
        }, TIMING.TRIGGER_PENDING_TIMEOUT_MS);
      } catch (err) {
        // Trigger failed — drop the optimistic message AND the trigger latch.
        useSessionStreamStore.getState().setOptimisticUserMessage(targetSessionId, null);
        useSessionStreamStore.getState().setTriggerPending(targetSessionId, false);

        if ((err as { code?: string }).code === 'SESSION_LOCKED') {
          if (clearInput) setInput(restoreContentOnLock);
          setSessionBusy(true);
          if (sessionBusyTimerRef.current) clearTimeout(sessionBusyTimerRef.current);
          sessionBusyTimerRef.current = setTimeout(() => {
            setSessionBusy(false);
            setError(null);
            sessionBusyTimerRef.current = null;
          }, TIMING.SESSION_BUSY_CLEAR_MS);
          return;
        }

        setError({
          heading: 'Could not send message',
          message: (err as Error).message || 'The request failed. Please try again.',
          retryable: true,
        });
      }
    },
    [sessionId, transport, queryClient, setInput, setError, setSessionBusy]
  );

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || status === 'streaming') return;
    const userContent = input.trim();
    await executeSubmission(userContent, true, userContent);
  }, [input, status, executeSubmission]);

  /**
   * Submit a message by content string directly, without clearing the input state.
   * Used by the auto-flush mechanism for queued messages.
   *
   * @param content - The message text to submit.
   * @param originSessionId - When supplied (queue auto-flush), the session the
   *   message was QUEUED in. Defense-in-depth (DOR-81): if it no longer matches
   *   the active session, the message is dropped (logged) rather than misdelivered
   *   — a queued message must never flush into a session the operator switched to.
   */
  const submitContent = useCallback(
    async (content: string, originSessionId?: string) => {
      if (!content.trim() || status === 'streaming') return;
      if (originSessionId !== undefined && originSessionId !== sessionId) {
        // Should be unreachable — the per-session queue key already pins the
        // flush to its origin. Logged + dropped so a wrong-session flush can
        // never silently misdeliver.
        console.warn(
          `[chat] Dropped a queued message whose origin session (${originSessionId}) no longer matches the active session (${sessionId ?? 'none'}).`
        );
        return;
      }
      await executeSubmission(content.trim(), false, '');
    },
    [status, sessionId, executeSubmission]
  );

  /** Interrupt the active turn; `/events` reports the resulting status. */
  const stop = useCallback(() => {
    if (sessionId) {
      void transport.interruptSession(sessionId).catch(() => {
        // Best-effort — the session may already be idle.
      });
    }
  }, [sessionId, transport]);

  /** Retry a failed message submission. */
  const retryMessage = useCallback(
    async (content: string) => {
      setError(null);
      await executeSubmission(content, false, '');
    },
    [executeSubmission, setError]
  );

  /**
   * Acknowledge a tool-interaction decision (approve/deny/answer).
   *
   * Under the durable `/events` contract the canonical status transition is
   * re-emitted by the server after the approve/deny/submit endpoint runs and
   * flows back through the stream store → projection, so the card resolves
   * without client-side optimistic patching. Kept as a stable no-op so the UI
   * decision callbacks have a consistent signature.
   *
   * @param _toolCallId - The interaction's tool-call id (unused; server re-emits status).
   * @param _answers - Submitted question answers (unused; server re-emits status).
   */
  const markToolCallResponded = useCallback(
    (_toolCallId: string, _answers?: Record<string, string>) => {
      // Intentionally inert — the /events re-emit owns the resolution.
    },
    []
  );

  return { handleSubmit, submitContent, stop, retryMessage, markToolCallResponded };
}
