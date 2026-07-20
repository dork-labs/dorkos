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
import type { Transport } from '@dorkos/shared/transport';
import type { ClientContext } from '@dorkos/shared/additional-context';
import { useTransport, useAppStore, useAgentBirthStore } from '@/layers/shared/model';
import { TIMING, buildUiStateSnapshot, prepareUiStateForSend } from '@/layers/shared/lib';
import { streamManager } from '@/layers/shared/lib/transport';
import {
  insertOptimisticSession,
  useSessionListStore,
  useSessionStreamStore,
} from '@/layers/entities/session';
import { useRuntimeCapabilities } from '@/layers/entities/runtime';
import type { SessionStoreActions } from './use-session-store-actions';
import type { NativeCommandResult } from './native-commands';
import type { ChatSessionOptions, ChatStatus } from './chat-types';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Options for the trigger POST — the `Transport.postMessage` options parameter. */
type PostMessageOptions = NonNullable<Parameters<Transport['postMessage']>[3]>;

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
  /** Launch-time runtime selection (`?runtime=`) — see {@link ChatSessionOptions.launchRuntime}. */
  launchRuntime: ChatSessionOptions['launchRuntime'];
  // Store setters (sourced from useSessionStoreActions)
  setInput: SessionStoreActions['setInput'];
  setError: SessionStoreActions['setError'];
  setSessionBusy: SessionStoreActions['setSessionBusy'];
  /**
   * Native (client-side) command interceptor. Returns a {@link NativeCommandResult}:
   * `handled` is true when `content` was a registered DorkOS command (the runtime
   * send is then skipped — it must never reach the model), and `ran` reports
   * whether it performed its action (so a rejected command keeps the composer text).
   */
  tryNativeCommand: (content: string) => NativeCommandResult;
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
  launchRuntime,
  setInput,
  setError,
  setSessionBusy,
  tryNativeCommand,
}: UseSessionSubmitParams) {
  // Refs to avoid stale closures inside the async submit callback.
  const selectedCwdRef = useRef(selectedCwd);
  useEffect(() => {
    selectedCwdRef.current = selectedCwd;
  }, [selectedCwd]);

  const launchRuntimeRef = useRef(launchRuntime);
  useEffect(() => {
    launchRuntimeRef.current = launchRuntime;
  }, [launchRuntime]);

  // Server default runtime — seeds the optimistic sidebar row when no launch
  // selection exists. Static for the server's lifetime (staleTime: Infinity).
  const { data: capabilitiesData } = useRuntimeCapabilities();
  const defaultRuntimeRef = useRef<string | undefined>(capabilitiesData?.defaultRuntime);
  useEffect(() => {
    defaultRuntimeRef.current = capabilitiesData?.defaultRuntime;
  }, [capabilitiesData?.defaultRuntime]);

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
   * Core submission logic shared by `handleSubmit`, `submitContent`, and the
   * auto-first-turn kickoff.
   *
   * @param content - The trimmed message text to send (PRISTINE — never annotated).
   * @param clearInput - When true, clears the input state after triggering.
   * @param restoreContentOnLock - Content to restore if the session is locked.
   * @param queued - True when this send originated from a queue auto-flush; sent
   *   as `context: { queued: true }` so the server renders a `<queue_note>`.
   * @param opts - `{ kickoff: true }` for the M4 auto-first-turn: the content is
   *   a DorkOS-injected "introduce yourself" instruction, not a person's typing,
   *   so it skips the native-command funnel, the file/content transform, and —
   *   the honesty seam — the optimistic user bubble. It still rides the full
   *   trigger machinery (subscribe-first, rekey, watchdog) so the greeting
   *   streams in normally.
   */
  const executeSubmission = useCallback(
    async (
      content: string,
      clearInput: boolean,
      restoreContentOnLock: string,
      queued = false,
      opts: { kickoff?: boolean } = {}
    ) => {
      // Native (client-side) command: runs locally and must NEVER reach the
      // runtime/model. This is the funnel safety net for the non-streaming paths
      // — handleSubmit (Enter) and retryMessage. A native command typed WHILE a
      // turn streams is intercepted earlier, at the queue decision (useChatQueue),
      // so it never enters the queue (a queued native command would flush without
      // starting a turn and stall everything queued behind it). Only clear the
      // input when the command actually ran — a rejected command (e.g. a no-arg
      // `/rename`) keeps the composer text so the operator can correct it. The
      // kickoff is a fenced synthetic instruction, never a command — skip the funnel.
      if (!opts.kickoff) {
        const native = tryNativeCommand(content);
        if (native.handled) {
          if (clearInput && native.ran) setInput('');
          return;
        }
      }

      const targetSessionId = sessionId!;
      const cwd = selectedCwdRef.current;
      const streamStore = useSessionStreamStore.getState();

      // A session absent from the list cache is being CREATED by this send —
      // the same signal gates both the optimistic sidebar row and the one-shot
      // runtime hint below. (A stale/empty cache can misread an existing
      // session as new; the resulting extra hint is harmless — the server's
      // persistSessionRuntime is first-write-wins.)
      const sessions = queryClient.getQueryData<Session[]>(['sessions', cwd]) ?? [];
      const isNewSession = !sessions.some((s) => s.id === targetSessionId);

      // Optimistically insert a placeholder session if not yet in the cache so
      // the sidebar shows the new conversation immediately.
      if (isNewSession) {
        const now = new Date().toISOString();
        insertOptimisticSession(queryClient, cwd, {
          id: targetSessionId,
          title: `Session ${targetSessionId.slice(0, 8)}`,
          createdAt: now,
          updatedAt: now,
          permissionMode: 'default',
          // Placeholder until the server's session_upserted event replaces this
          // row: the launch selection when one exists, otherwise the server
          // default runtime, so the row's runtime mark is right from first paint.
          runtime: launchRuntimeRef.current ?? defaultRuntimeRef.current ?? 'claude-code',
        });
      }

      // Show the user's message immediately — it is NOT in the (pre-send)
      // snapshot and the /events stream carries no user-message event. The
      // kickoff has no such bubble: the person typed nothing, so the birth
      // session opens with only the certificate line and the agent's greeting.
      const optimisticId = crypto.randomUUID();
      if (!opts.kickoff) {
        streamStore.setOptimisticUserMessage(targetSessionId, { id: optimisticId, content });
      }
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
        // The kickoff content is already the exact message to deliver — never
        // run it through the file/content transform (there are no pending files
        // on a brand-new session, and it must reach the model verbatim so the
        // fence stays intact for suppression).
        const finalContent =
          !opts.kickoff && transformContentRef.current
            ? await transformContentRef.current(content)
            : content;

        // Client UI-state snapshot for agent situational awareness (ADR-0273),
        // omitted when unchanged since the last successful send for this session
        // so identical snapshots don't accumulate in the transcript.
        const uiSnapshot = buildUiStateSnapshot(useAppStore.getState(), cwd ?? null);
        const { uiState, commit: commitUiState } = prepareUiStateForSend(
          targetSessionId,
          uiSnapshot
        );
        const context: ClientContext | undefined =
          uiState || queued
            ? { ...(uiState ? { uiState } : {}), ...(queued ? { queued: true } : {}) }
            : undefined;

        const postOptions: PostMessageOptions = {
          clientMessageId: optimisticId,
          context,
        };
        // First-turn runtime hint: only the session-creating send carries the
        // explicit launch selection. No selection → omit entirely, so the
        // server's own resolution (agent manifest, then default) stays in
        // charge (resolveRuntimeTypeForNewSession priority order).
        if (isNewSession && launchRuntimeRef.current) {
          postOptions.runtime = launchRuntimeRef.current;
        }

        const { sessionId: canonicalId } = await transport.postMessage(
          targetSessionId,
          finalContent,
          cwd ?? undefined,
          postOptions
        );

        // Record the snapshot as sent (under the canonical id after a rekey) so
        // the next turn only re-sends uiState when it actually changed.
        commitUiState(canonicalId);

        // Create-on-first-message rekey: the SDK assigned a different canonical
        // id. Re-target the durable stream, move the optimistic state to the new
        // key, drop the stale entry, and rewrite the URL in place.
        if (canonicalId !== targetSessionId) {
          streamManager.attachSession(canonicalId, cwd);
          // Move the optimistic message, the trigger latch, and any compose-next
          // queue from the throwaway client UUID to the canonical id, so the
          // first turn's client-authored state follows the (now-canonical) same
          // logical session (DOR-81 / DOR-74). The retire announce on the global
          // stream fires the same migration when the canonical id resolves only
          // AFTER this 202 (the common Claude path — see session-stream-binding).
          useSessionStreamStore.getState().migrateSessionContinuity(targetSessionId, canonicalId);
          // Move the newborn-agent birth ceremony (M4) to the canonical id too,
          // for the case the rekey resolves synchronously here (no-op without a
          // birth record; idempotent with the retire-announce migration).
          useAgentBirthStore.getState().migrate(targetSessionId, canonicalId);

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
          // Follow a rekey that resolved AFTER this 202: the retire-announce
          // migration moves the latch to the canonical id, so the watchdog must
          // check/clear THERE — watching the retired id would let a turn that
          // dies without canonical-id events wedge the composer in queue mode.
          const watchedId = useSessionListStore.getState().rekeys[latchedId] ?? latchedId;
          const session = useSessionStreamStore.getState().getSession(watchedId);
          if (session.triggerPending && session.status?.lifecycle !== 'streaming') {
            useSessionStreamStore.getState().setTriggerPending(watchedId, false);
          }
        }, TIMING.TRIGGER_PENDING_TIMEOUT_MS);
      } catch (err) {
        // Trigger failed — drop the optimistic message AND the trigger latch.
        useSessionStreamStore.getState().setOptimisticUserMessage(targetSessionId, null);
        useSessionStreamStore.getState().setTriggerPending(targetSessionId, false);

        if ((err as { code?: string }).code === 'SESSION_LOCKED') {
          // A locked birth session means a turn is already running — the
          // greeting rode another trigger. Nothing to restore or retry.
          if (opts.kickoff) return;
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

        // A failed kickoff propagates to useAutoKickoff, which retries once and
        // — if that is also spent — surfaces an honest greeting-failed line on
        // the empty session. Deliberately NO "Could not send message" banner:
        // the person typed nothing, so that copy (and its Retry, which would
        // find no user message to resend) would be dishonest and dead. The
        // composer stays fully usable — a rejected trigger started no turn.
        if (opts.kickoff) throw err;

        setError({
          heading: 'Could not send message',
          message: (err as Error).message || 'The request failed. Please try again.',
          retryable: true,
        });
      }
    },
    [sessionId, transport, queryClient, setInput, setError, setSessionBusy, tryNativeCommand]
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
   * @param content - The message text to submit (PRISTINE — never annotated).
   * @param originSessionId - When supplied (queue auto-flush), the session the
   *   message was QUEUED in. Defense-in-depth (DOR-81): if it no longer matches
   *   the active session, the message is dropped (logged) rather than misdelivered
   *   — a queued message must never flush into a session the operator switched to.
   * @param opts - `{ queued }` carries the queue origin out-of-band so the send
   *   forwards `context: { queued: true }` (ADR-0273). Defaults to non-queued.
   */
  const submitContent = useCallback(
    async (content: string, originSessionId?: string, opts?: { queued: boolean }) => {
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
      await executeSubmission(content.trim(), false, '', opts?.queued ?? false);
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
   * Trigger the agent's auto-first-turn (M4). `content` is a fenced kickoff
   * instruction built at creation. Rides the full trigger machinery but shows
   * no user bubble — the birth session opens with the agent's greeting alone.
   * The caller (useAutoKickoff) owns the fire-once guard.
   *
   * @param content - The fenced kickoff message.
   */
  const submitKickoff = useCallback(
    async (content: string) => {
      await executeSubmission(content, false, '', false, { kickoff: true });
    },
    [executeSubmission]
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

  return { handleSubmit, submitContent, stop, retryMessage, submitKickoff, markToolCallResponded };
}
