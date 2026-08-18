/**
 * What the session's live lane is showing.
 *
 * The lifecycle half of the old `ChatStatusStrip`: the elapsed clock, the
 * bypass reading, and the post-turn summary that has to survive the turn ending
 * in order to be shown at all. The priority stack itself moved to
 * `features/conversation`'s `deriveLaneState`, which every surface now shares —
 * this is the session's own inputs on their way into it.
 *
 * @module widgets/session/model/use-session-lane-state
 */
import { useEffect, useRef, useState } from 'react';
import type { PermissionMode } from '@dorkos/shared/types';
import type { SessionActivity } from '@dorkos/shared/session-stream';
import {
  deriveLaneState,
  NO_ASKS,
  type LaneAsk,
  NO_PRESENCE,
  type LaneState,
} from '@/layers/features/conversation';
import { useElapsedTime } from '@/layers/shared/model';
import { isBypassPermissionMode, TIMING } from '@/layers/shared/lib';
import type {
  OperationProgressState,
  SystemStatusState,
} from '@/layers/shared/model/chat-message-types';
import { SESSION_CAPABILITIES } from './session-capabilities';

/** Everything the session hands the lane. */
export interface SessionLaneInput {
  /** Where the turn is. */
  status: 'idle' | 'streaming' | 'error';
  /** When the current turn began, or `null` between turns. */
  streamStartTime: number | null;
  /** The running token estimate. */
  estimatedTokens: number;
  /** The session's permission mode, as its own runtime reports it. */
  permissionMode: PermissionMode;
  /**
   * Prompts this session is parked on, from the fleet-wide list.
   *
   * Rung 1, and the reason it is passed in rather than read here: the hook is
   * about the session's TURN, and what is waiting on a person is a fact about
   * the fleet that the host already holds for the transcript.
   */
  asks?: readonly LaneAsk[];
  /** True while the turn is parked on the person. */
  isWaitingForUser: boolean;
  /** Which kind of wait it is. */
  waitingType: 'approval' | 'question';
  /** A long operation's progress, or absent when none is running. */
  operationProgress?: OperationProgressState | null;
  /** An informational runtime event, or absent when there is none. */
  systemStatus?: SystemStatusState | null;
  /** What this session is doing, from the fleet-wide reading. */
  activity: SessionActivity | null;
}

/** Format a token count for display (e.g. 3200 -> "~3.2k tokens"). */
function formatTokens(count: number): string {
  if (count >= 1000) {
    return `~${(count / 1000).toFixed(1)}k tokens`;
  }
  return `~${Math.round(count)} tokens`;
}

/**
 * Derive the session lane's state, and own the two things it needs a memory for.
 *
 * **The completed flash is why this is a hook.** A turn's elapsed time and token
 * count stop existing the moment the turn ends, and the summary is shown after
 * that — so the last reading is snapshotted while the turn runs and dismissed on
 * a timer afterwards. Everything else here is a straight read.
 *
 * **Three of the lane's ten rungs are deliberately dark on this surface**, and
 * each has a reason rather than a gap:
 *
 * - `ask` — its input does not exist until P3 (DOR-1330); see `LaneAsk`.
 * - `stalled` — a session already reports its connection in `ChatStatusSection`,
 *   inside the composer card, which P2 deliberately does not fold. Wiring a
 *   second line for it here would be two places saying one thing, which is the
 *   duplication this programme exists to remove. P4 decides which of them owns
 *   it when the footer lands.
 * - `queued` — its source is `ConversationTarget.queueDepth`, and the composer
 *   host that supplies one is P4's (DOR-1331). Today the composer draws its own
 *   queue chips.
 *
 * @param input - The session's own state.
 * @returns What the lane should say right now.
 */
export function useSessionLaneState(input: SessionLaneInput): LaneState {
  const { formatted: elapsed } = useElapsedTime(
    input.status === 'streaming' ? input.streamStartTime : null
  );

  // `isBypassPermissionMode` (not a literal `'bypassPermissions'` compare):
  // `input.permissionMode` carries whatever id the session's own runtime reports
  // (DOR-851), and `always-allow` — test-mode's bypass mode — is a different
  // literal with the same meaning. A literal compare here missed it and never
  // warned at all on that runtime.
  const isBypass = isBypassPermissionMode(input.permissionMode);

  // Snapshot the final readings while the turn runs, so the summary after it has
  // something true to show.
  const lastElapsedRef = useRef(elapsed);
  const lastTokensRef = useRef(input.estimatedTokens);
  const [showComplete, setShowComplete] = useState(false);

  useEffect(() => {
    if (input.status === 'streaming') {
      lastElapsedRef.current = elapsed;
      lastTokensRef.current = input.estimatedTokens;
      setShowComplete(false);
    }
  }, [input.status, elapsed, input.estimatedTokens]);

  // Streaming → idle with tokens spent is what earns the summary.
  const prevStatusRef = useRef(input.status);
  useEffect(() => {
    if (
      prevStatusRef.current === 'streaming' &&
      input.status === 'idle' &&
      lastTokensRef.current > 0
    ) {
      setShowComplete(true);
    }
    prevStatusRef.current = input.status;
  }, [input.status]);

  useEffect(() => {
    if (!showComplete) return;
    const timer = setTimeout(() => setShowComplete(false), TIMING.TURN_COMPLETE_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [showComplete]);

  return deriveLaneState({
    capabilities: SESSION_CAPABILITIES,
    asks: input.asks ?? NO_ASKS,
    stalled: false,
    presence: NO_PRESENCE,
    queueDepth: 0,
    turn: {
      status: input.status,
      isWaitingForUser: input.isWaitingForUser,
      waitingType: input.waitingType,
      // `message` is optional on the session's own shape and nullable on the
      // lane's: the lane is fed by more than one producer and `null` is the one
      // spelling of "nothing said" it accepts.
      operationProgress:
        input.operationProgress == null
          ? null
          : {
              message: input.operationProgress.message ?? null,
              determinate: input.operationProgress.determinate,
              percent: input.operationProgress.percent ?? null,
            },
      systemStatus: input.systemStatus ?? null,
      elapsed,
      activity: input.activity,
      tokens: formatTokens(input.estimatedTokens),
      isBypass,
      showComplete,
      // eslint-disable-next-line react-hooks/refs -- Intentional: snapshot refs read during render for post-stream display
      lastElapsed: lastElapsedRef.current,
      // eslint-disable-next-line react-hooks/refs -- Intentional: snapshot refs read during render for post-stream display
      lastTokens: formatTokens(lastTokensRef.current),
    },
  });
}
