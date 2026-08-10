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
  sessionKeys,
} from '@/layers/entities/session';
import { useRuntimeCapabilities } from '@/layers/entities/runtime';
import { clearComposerOnConfirmed } from '../lib/clear-composer-on-confirmed';
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
  /** Background for this turn — see {@link ChatSessionOptions.takeSeedContext}. */
  takeSeedContext: ChatSessionOptions['takeSeedContext'];
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
  takeSeedContext,
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

  const takeSeedContextRef = useRef(takeSeedContext);
  useEffect(() => {
    takeSeedContextRef.current = takeSeedContext;
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
   * @param queued - True when this send originated from a queue flush; sent
   *   as `context: { queued: true }` so the server renders a `<queue_note>`.
   * @param opts - `{ kickoff: true }` for the M4 auto-first-turn: the content is
   *   a DorkOS-injected "introduce yourself" instruction, not a person's typing,
   *   so it skips the native-command funnel, the file/content transform, and —
   *   the honesty seam — the optimistic user bubble. It still rides the full
   *   trigger machinery (subscribe-first, rekey, watchdog) so the greeting
   *   streams in normally.
   *   `{ restoreQueued }` is the queue's undo for a flushed message: the queue
   *   dequeues before the trigger resolves, so ANY failed trigger — a lock the
   *   server still holds while a turn sits blocked on an approval, a dead
   *   network — has to put the message back rather than drop it (DOR-480).
   *   `{ cwd }` pins the working directory for THIS send, overriding the ambient
   *   selected directory. The newborn-agent kickoff uses it to run the first turn
   *   in the agent's own directory (from the birth record) rather than whatever
   *   directory global state happens to hold when the auto-fire races the URL's
   *   `?dir=` settling — a mismatch that wrote the transcript under the wrong
   *   project slug, so every later resume failed with "No conversation found".
   */
  const executeSubmission = useCallback(
    async (
      content: string,
      clearInput: boolean,
      restoreContentOnLock: string,
      queued = false,
      opts: { kickoff?: boolean; restoreQueued?: () => void; cwd?: string } = {}
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
          // A REJECTED command performed nothing, and this return is upstream of
          // the try/catch that restores a queued flush — so a queued message the
          // operator had rewritten into one (say a bare `/rename`) was dequeued
          // and then simply ceased to exist: the composer never held it either
          // (DOR-480). Put it back. Restoring is idempotent, so a later edge that
          // flushes it again just returns it again, and the row stays on screen
          // with its Send-now control until the text is corrected.
          //
          // A command that RAN is not restored — it did what was asked, so the
          // message is consumed and re-queueing would re-run it on every edge.
          // But `ran` is only "the dispatch started" for a command that finishes
          // asynchronously: a queued `/compact` refused by the session lock would
          // otherwise be spent with no compaction and nothing to recover. Settle
          // those on `confirmed` instead, so "it ran" has to be true before the
          // message is treated as gone.
          if (!native.ran) {
            opts.restoreQueued?.();
          } else if (native.confirmed && opts.restoreQueued) {
            const restoreQueued = opts.restoreQueued;
            // The rejection arm is not defensive padding: without it "never
            // rejects" is a convention two producers happen to honour rather
            // than something the call site can rely on. Treating an unexpected
            // rejection as "not confirmed" is also the right default — it puts
            // the message back instead of silently eating it.
            void native.confirmed.then(
              (accepted) => {
                if (!accepted) restoreQueued();
              },
              () => restoreQueued()
            );
          }
          // The composer's clear settles on `confirmed` for the same reason the
          // queue's undo does: emptying it on "the dispatch started" deleted
          // `/compact focus on the API changes` and then toasted that the agent
          // was busy, with the instructions already gone.
          if (clearInput && native.ran) {
            if (native.confirmed) {
              clearComposerOnConfirmed(sessionId, content, native.confirmed);
            } else {
              setInput('');
            }
          }
          return;
        }
      }

      const targetSessionId = sessionId!;
      // An explicit override (the newborn kickoff's agent directory) wins over the
      // ambient selected directory, which the auto-fire can read before the URL's
      // `?dir=` has settled onto the new agent.
      const cwd = opts.cwd ?? selectedCwdRef.current;
      setError(null);

      // Subscribe-first, and BEFORE the upload await. `attachSession` re-targets
      // the single active-session connection, and the only other caller is an
      // effect keyed on (sessionId, cwd) that fires once per switch — so calling
      // it after an await means a switch made DURING the upload gets undone:
      // session B attaches, the upload resolves, and this line drags the
      // connection back to A, leaving B on screen with no live stream and
      // nothing to re-fire until the session or cwd changes again. Here it is a
      // no-op against the effect that already attached this same session.
      streamManager.attachSession(targetSessionId, cwd);

      // Attachments upload next — before the optimistic bubble, before the
      // trigger latch, before the composer is cleared.
      //
      // Latching first made the session read `streaming` for the whole upload:
      // the button turned into a red Stop that called `interruptSession` on a
      // session with no turn, the `.catch()` swallowed the refusal, and the
      // click did nothing at all. Worse, a hung upload never cleared the latch,
      // because the watchdog that releases it is only armed after the POST, so
      // the composer stayed wedged in queue mode indefinitely. While this runs
      // the composer shows the upload in place of Stop and both submit paths
      // are closed (`isUploading`) — and the upload itself can be cancelled,
      // which is what keeps that window from becoming a wedge of its own
      // (`useFileUpload.cancelUpload`).
      let finalContent: string;
      try {
        // The kickoff content is already the exact message to deliver — never
        // run it through the file/content transform (there are no pending files
        // on a brand-new session, and it must reach the model verbatim so the
        // fence stays intact for suppression).
        finalContent =
          !opts.kickoff && transformContentRef.current
            ? await transformContentRef.current(content)
            : content;
      } catch (err) {
        // Nothing was sent. A queued message goes back to its row; a typed one
        // is still in the composer, because `clearInput` has not run yet — the
        // clear used to happen before the upload and only `SESSION_LOCKED`
        // restored it, so an upload failure on an ordinary send destroyed the
        // message outright.
        opts.restoreQueued?.();
        if (opts.kickoff) throw err;
        setError({
          heading: 'Could not send message',
          message: (err as Error).message || 'The attachment did not upload. Please try again.',
          // The words are still in the composer (or back in the queue row), so
          // the retry is a keystroke away. A Retry button here would re-send the
          // PREVIOUS user message, which is not what anyone asked for.
          retryable: false,
        });
        return;
      }

      const streamStore = useSessionStreamStore.getState();

      // A session absent from the list cache is being CREATED by this send —
      // the same signal gates both the optimistic sidebar row and the one-shot
      // runtime hint below. (A stale/empty cache can misread an existing
      // session as new; the resulting extra hint is harmless — the server's
      // persistSessionRuntime is first-write-wins.)
      const sessions = queryClient.getQueryData<Session[]>(sessionKeys.list(cwd)) ?? [];
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

      try {
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

        // Background a surface attached to this turn (Ask DorkBot, BC-48). Asked
        // on every send and answered at most once per conversation — the latch is
        // the provider's, so there is nothing here to get out of step. It is not
        // folded into `context`: `seedContext` is prose written FOR the model,
        // and the neutral client-signal bag is not (ADR-0273).
        const seedContext = takeSeedContextRef.current?.();
        if (seedContext) postOptions.seedContext = seedContext;

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

          const cachedSessions = queryClient.getQueryData<Session[]>(sessionKeys.list(cwd)) ?? [];
          const optimisticEntry = cachedSessions.find((s) => s.id === targetSessionId);
          if (optimisticEntry && !cachedSessions.some((s) => s.id === canonicalId)) {
            insertOptimisticSession(queryClient, cwd, { ...optimisticEntry, id: canonicalId });
          }
          // Drop the stale client-UUID row — without this the sidebar shows a
          // ghost duplicate ("Session xxxxxxxx" pointing at a dead id) until the
          // next list refetch, which no longer happens on a timer.
          queryClient.setQueryData<Session[]>(sessionKeys.list(cwd), (prev) =>
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

        // A queued message was dequeued to make this attempt. The attempt failed,
        // so it goes straight back where it was — every failure mode, not just the
        // lock: the composer was never holding this text, so dropping it here is
        // pure data loss with nowhere to recover it from (DOR-480). The queue row
        // reappears with its Send-now control, so the person can see it survived
        // and retry deliberately.
        opts.restoreQueued?.();

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
   * Used by the queue's flush (automatic and hand-triggered).
   *
   * @param content - The message text to submit (PRISTINE — never annotated).
   * @param originSessionId - When supplied (queue flush), the session the message
   *   was QUEUED in. Defense-in-depth (DOR-81): if it no longer matches the
   *   active session, the message is NOT delivered here — it goes back into its
   *   own session's queue, because a queued message must never flush into a
   *   session the operator switched to.
   * @param opts - `{ queued }` carries the queue origin out-of-band so the send
   *   forwards `context: { queued: true }` (ADR-0273). `{ restore }` puts the
   *   message back in its queue when the send does not happen — every refusal
   *   path below, and every failed trigger, calls it (DOR-480). Defaults to
   *   non-queued.
   */
  const submitContent = useCallback(
    async (
      content: string,
      originSessionId?: string,
      opts?: { queued: boolean; restore?: () => void; cwd?: string }
    ) => {
      if (!content.trim() || status === 'streaming') {
        // A turn started between the drain decision and this call. The message is
        // already dequeued, so put it back — it will ride the next edge.
        opts?.restore?.();
        return;
      }
      if (originSessionId !== undefined && originSessionId !== sessionId) {
        // Should be unreachable — the per-session queue key already pins the
        // flush to its origin. Logged, and returned to its OWN queue (the restore
        // closes over the origin session), so a wrong-session flush can neither
        // misdeliver nor destroy the message.
        console.warn(
          `[chat] Refused a queued message whose origin session (${originSessionId}) no longer matches the active session (${sessionId ?? 'none'}); it stays queued in its origin.`
        );
        opts?.restore?.();
        return;
      }
      await executeSubmission(content.trim(), false, '', opts?.queued ?? false, {
        ...(opts?.restore ? { restoreQueued: opts.restore } : {}),
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      });
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
   * @param cwd - The agent's own directory (from the birth record). Pins the
   *   first turn to it so the transcript is written under the agent's project
   *   slug — the same slug the session view later resumes from — instead of the
   *   ambient selected directory, which can still be the previous default when
   *   the kickoff fires on navigation.
   */
  const submitKickoff = useCallback(
    async (content: string, cwd?: string) => {
      await executeSubmission(content, false, '', false, {
        kickoff: true,
        ...(cwd ? { cwd } : {}),
      });
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
