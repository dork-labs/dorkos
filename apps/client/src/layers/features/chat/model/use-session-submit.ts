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
import type { MessageDisposition, QueuedMessage } from '@dorkos/shared/schemas';
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
import { useInteractionStore } from '@/layers/entities/interactions';
import { carryInteractionForward } from '../lib/carry-interaction-forward';
import { clearComposerOnConfirmed } from '../lib/clear-composer-on-confirmed';
import { sequenceEnqueue } from '../lib/enqueue-sequencer';
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
  /**
   * Launch-time Claude Code billing selection: a registry id
   * (`runtimes.claudeCode.accounts[].id`) the status bar is holding for this
   * session, or `null`/`undefined` for no hint. Sent as `account` on the
   * session-creating first message ONLY — after launch the account is a fact on
   * disk (ADR 260801-204127), so a later send carrying it would ask for
   * something impossible and the server would warn and ignore it. Absent means
   * the server's ladder decides (the agent's account, then the default).
   */
  launchAccount?: string | null;
  /** Background for this turn — see {@link ChatSessionOptions.takeSeedContext}. */
  takeSeedContext: ChatSessionOptions['takeSeedContext'];
  // Store setters (sourced from useSessionStoreActions)
  setInput: SessionStoreActions['setInput'];
  setError: SessionStoreActions['setError'];
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
  launchAccount,
  takeSeedContext,
  setInput,
  setError,
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

  const launchAccountRef = useRef(launchAccount);
  useEffect(() => {
    launchAccountRef.current = launchAccount;
  }, [launchAccount]);

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

  // ---------------------------------------------------------------------------
  // Submission
  // ---------------------------------------------------------------------------

  /**
   * Core submission logic shared by `submitContent` (and therefore by the
   * composer's own Enter, which reaches it through the session's
   * `ConversationTarget.send`), `retryMessage`, and the auto-first-turn kickoff.
   *
   * @param content - The trimmed message text to send (PRISTINE — never annotated).
   * @param clearInput - When true, clears the input state after triggering.
   * @param opts - `{ kickoff: true }` for the M4 auto-first-turn: the content is
   *   a DorkOS-injected "introduce yourself" instruction, not a person's typing,
   *   so it skips the native-command funnel, the file/content transform, and —
   *   the honesty seam — the optimistic user bubble. It still rides the full
   *   trigger machinery (subscribe-first, rekey, watchdog) so the greeting
   *   streams in normally.
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
      opts: { kickoff?: boolean; cwd?: string } = {}
    ) => {
      // Native (client-side) command: runs locally and must NEVER reach the
      // runtime/model. This is the funnel safety net for the non-streaming paths
      // — submitContent (which is where Enter lands, through the session's
      // `ConversationTarget.send`) and retryMessage. A native command typed WHILE a
      // turn streams is intercepted earlier, at the queue decision (useChatQueue),
      // so it never enters the queue (a queued native command would flush without
      // starting a turn and stall everything queued behind it). Only clear the
      // input when the command actually ran — a rejected command (e.g. a no-arg
      // `/rename`) keeps the composer text so the operator can correct it. The
      // kickoff is a fenced synthetic instruction, never a command — skip the funnel.
      if (!opts.kickoff) {
        const native = tryNativeCommand(content);
        if (native.handled) {
          // The composer's clear settles on `confirmed`, never on `ran`:
          // emptying it on "the dispatch started" deleted `/compact focus on the
          // API changes` and then toasted that the agent was busy, with the
          // instructions already gone (DOR-480).
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

      // **Writing is the strongest thing a person can do to a conversation, so
      // it is recorded like opening one** (DOR-1156). Today's membership and
      // order are `max(userLastMessageAt, userLastOpenedAt)` (BC-16), and the
      // client half of that pair was only ever written by a click on a sidebar
      // row — so a person could type a paragraph into an agent, walk away, and
      // find the conversation nowhere in Today. Recorded HERE, at the act,
      // rather than on the 202: the operator's rule is about what THEY did, and
      // a message that fails to reach the runtime was still one they wrote.
      //
      // The agent gets a record too, exactly as `SidebarChrome.openSession`
      // does, so one act updates both the conversation's place in Today and the
      // agent's frecency — a thing you write in is a thing you use.
      //
      // The kickoff is the one send excluded, because nobody performed an act:
      // it is DorkOS-injected, so nothing it does is evidence of the operator's
      // attention. That is the honesty seam this hook applies everywhere else.
      //
      // **A queued message cannot reach this function at all**, and that is
      // worth saying out loud because it used to and had to be excluded by
      // hand. The queue is the server's now (`persistent-session-runtime`):
      // {@link enqueueContent} posts with `disposition: 'queue'` and the server
      // dispatches when the running turn ends. So the only callers left are the
      // operator's own — `submitContent`, `retryMessage` — plus the kickoff.
      // Were a flush ever routed back through here, it would advance Today's
      // order key at the instant an AGENT finished talking, which BC-16 forbids
      // outright; the enqueue site records instead, at the keystroke
      // (`useChatQueue.handleQueue`).
      if (!opts.kickoff) {
        useInteractionStore.getState().recordOpened('session', targetSessionId);
        if (cwd) useInteractionStore.getState().recordOpened('agent', cwd);
      }

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
        // Nothing was sent, and the words are still in the composer because
        // `clearInput` has not run yet — the clear used to happen before the
        // upload, with nothing to put the words back, so an upload failure on
        // an ordinary send destroyed the message outright (DOR-480).
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
        const context: ClientContext | undefined = uiState ? { uiState } : undefined;

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
        // First-turn billing hint, gated on the SAME signal for the same reason:
        // the account is fixed to the one that created the session (ADR
        // 260801-204127), so only the creating send can name it. No pick → omit
        // entirely, leaving the server's ladder (agent, then default) in charge.
        if (isNewSession && launchAccountRef.current) {
          postOptions.account = launchAccountRef.current;
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
          // The interaction the send above recorded is bucketed under the
          // throwaway id too, and Today walks the session LIST — so left behind
          // it names a session no list will ever contain, and the conversation
          // the operator just started is absent from Today the moment they open
          // something else. Same migration by the other route in
          // `useSessionRekeyRedirect`.
          carryInteractionForward(targetSessionId, canonicalId);
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
    [sessionId, transport, queryClient, setInput, setError, tryNativeCommand]
  );

  /**
   * Submit a message by content string.
   *
   * The one content-taking send verb: the composer's Enter reaches it through
   * the session's `ConversationTarget.send`, and a retry or a kickoff reaches it
   * directly. Refuses an empty message and a session already streaming, so no
   * caller has to repeat either guard.
   *
   * @param content - The message text to submit (PRISTINE — never annotated).
   * @param opts - `{ cwd }` pins the working directory for this send.
   *   `{ clearInput }` empties the composer once the message is actually on its
   *   way — after the attachment transform, never before it, so a failed upload
   *   leaves the words where they were typed (DOR-480). A retry passes neither:
   *   its words are already in the transcript, not in the box.
   */
  const submitContent = useCallback(
    async (content: string, opts?: { cwd?: string; clearInput?: boolean }) => {
      if (!content.trim() || status === 'streaming') return;
      await executeSubmission(content.trim(), opts?.clearInput === true, {
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      });
    },
    [status, executeSubmission]
  );

  /**
   * Send whatever is in the composer right now, and empty it.
   *
   * The zero-argument form `useLaunchPrompt` sends through: a launch link
   * seeds the composer and then asks for exactly what pressing Enter would do,
   * with no second route to the runtime. The composer's own Enter does NOT come
   * through here — it carries its draft down the session's
   * `ConversationTarget.send` and lands in {@link submitContent} with it.
   */
  const handleSubmit = useCallback(
    () => submitContent(input, { clearInput: true }),
    [input, submitContent]
  );

  /**
   * Deliver a message to a session that is already working, under the requested
   * disposition (spec `persistent-session-runtime` §2). The server resolves what
   * actually happens — queue behind the turn, steer into it, or stage context
   * for the next one — and degrades honestly when the runtime cannot honour the
   * ask, so this only states the intent and lets the outcome ride back on the
   * event stream.
   *
   * Deliberately NOT {@link executeSubmission}. None of these three open a turn
   * of their own, so they get none of that path's turn machinery: no optimistic
   * user bubble (a queued message has not been said yet — its chip stands for it;
   * a steer's inline bubble arrives on the stream as `turn_input`; a staged note
   * is a `context_staged` receipt), no trigger latch, and no rekey handling (a
   * session already working has run a turn, so its id is already canonical).
   *
   * What all three DO share is everything about the message itself: attachments
   * upload now rather than at dispatch, and the client's UI-state snapshot is
   * taken now, because now is when the person was looking at it.
   *
   * @param content - The message text to deliver (PRISTINE — never annotated).
   * @param disposition - What to do with it mid-turn: `queue`, `steer`, `stage`.
   * @param errorHeading - The heading for the "it did not go through" banner.
   * @returns `true` once the server has the message. The composer holds the
   *   words until this resolves, so a refusal leaves them exactly where they
   *   were typed rather than needing an undo (DOR-480).
   */
  const deliverWithDisposition = useCallback(
    async (
      content: string,
      disposition: MessageDisposition,
      errorHeading: string
    ): Promise<boolean> => {
      if (!sessionId) return false;
      const targetSessionId = sessionId;
      const cwd = selectedCwdRef.current;
      setError(null);

      // Sequence this session's delivery POSTs so the server accepts them in
      // keystroke order (DOR-1165). Each message is its own POST and the server
      // orders by acceptance, so two POSTs fired ~20ms apart (a fast typist, a
      // paste-and-Enter hammer) could be accepted out of order and transpose what
      // the person typed. The chain claims its slot HERE, at the synchronous head
      // of the call — before the attachment transform's await — so ordering
      // follows the order the keys were pressed, not the order uploads happen to
      // finish. This is request ordering only: no queue state, no gating on turn
      // status (see enqueue-sequencer).
      return sequenceEnqueue(targetSessionId, async (): Promise<boolean> => {
        let finalContent: string;
        try {
          finalContent = transformContentRef.current
            ? await transformContentRef.current(content)
            : content;
        } catch (err) {
          setError({
            heading: errorHeading,
            message: (err as Error).message || 'The attachment did not upload. Please try again.',
            retryable: false,
          });
          return false;
        }

        try {
          const uiSnapshot = buildUiStateSnapshot(useAppStore.getState(), cwd ?? null);
          const { uiState, commit: commitUiState } = prepareUiStateForSend(
            targetSessionId,
            uiSnapshot
          );
          // `queued: true` becomes the server's `<queue_note>` — the same
          // out-of-band signal the old client-side flush carried (ADR-0273). It
          // belongs to a QUEUED message alone: a steer joins the live turn and a
          // staged note rides the next dispatch, and neither is a queue note. The
          // content itself is never annotated, whatever the disposition.
          const contextEntries: ClientContext = {
            ...(uiState ? { uiState } : {}),
            ...(disposition === 'queue' ? { queued: true } : {}),
          };
          const context = Object.keys(contextEntries).length > 0 ? contextEntries : undefined;
          const { sessionId: canonicalId } = await transport.postMessage(
            targetSessionId,
            finalContent,
            cwd ?? undefined,
            { context, disposition }
          );
          commitUiState(canonicalId);
          return true;
        } catch (err) {
          setError({
            heading: errorHeading,
            message: (err as Error).message || 'The request failed. Please try again.',
            // The words are still in the composer, so the retry is a keystroke
            // away. A Retry button here would re-send the PREVIOUS user message,
            // which is not what anyone asked for.
            retryable: false,
          });
          return false;
        }
      });
    },
    [sessionId, transport, setError]
  );

  /** Put a message on the session's queue, behind the running turn. */
  const enqueueContent = useCallback(
    (content: string): Promise<boolean> =>
      deliverWithDisposition(content, 'queue', 'Could not queue message'),
    [deliverWithDisposition]
  );

  /** Send a message into the running turn now (steer), so the agent changes course. */
  const steerContent = useCallback(
    (content: string): Promise<boolean> =>
      deliverWithDisposition(content, 'steer', 'Could not steer the agent'),
    [deliverWithDisposition]
  );

  /** Add context the agent uses next, without cutting into the running turn (stage). */
  const addContextContent = useCallback(
    (content: string): Promise<boolean> =>
      deliverWithDisposition(content, 'stage', 'Could not add context'),
    [deliverWithDisposition]
  );

  /**
   * Interrupt the active turn and empty its queue; `/events` reports the
   * resulting status and the emptied queue. Resolves with the messages the
   * server took off the queue, head first, so the caller can hand the words
   * back to the composer — nothing typed is destroyed by a Stop. Resolves empty
   * when there was no session, nothing queued, or the interrupt failed.
   */
  const stop = useCallback(async (): Promise<QueuedMessage[]> => {
    if (!sessionId) return [];
    try {
      const { cancelledQueued } = await transport.interruptSession(sessionId);
      return cancelledQueued ?? [];
    } catch {
      // Best-effort — the session may already be idle.
      return [];
    }
  }, [sessionId, transport]);

  /** Retry a failed message submission. */
  const retryMessage = useCallback(
    async (content: string) => {
      setError(null);
      await executeSubmission(content, false);
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
      await executeSubmission(content, false, {
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

  return {
    handleSubmit,
    submitContent,
    enqueueContent,
    steerContent,
    addContextContent,
    stop,
    retryMessage,
    submitKickoff,
    markToolCallResponded,
  };
}
