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
 * **Two of the lane's nine rungs are deliberately dark on this surface**, and
 * each is a decision rather than a gap:
 *
 * - `ask` draws nothing here: the prompt already has a live card in the
 *   composer's own slot, which is where a person answers it, and a receipt row
 *   in the transcript where it was asked. A third line six pixels above the card
 *   it duplicates is the noise this programme exists to remove — see
 *   `ChatPanel`, which passes `NO_ASKS` and says so at length. The room's lane,
 *   which has no inline card, draws it.
 * - `stalled` draws nothing here either: `ChatStatusSection`'s connection chip,
 *   under the same box, is the cockpit's app-wide home for connection health,
 *   and two alarms about one fact teach people to read neither. The lane's
 *   sentence is a room's vocabulary anyway — a session has a turn, not new
 *   messages that have stopped coming through. `SESSION_CAPABILITIES` says so
 *   with `streamHealth: false`, and `deriveLaneState` is where that is read.
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
  // `prevStatusRef` is what turns "streaming" into "just started" and
  // "streaming → idle" into "just finished" — the two transitions the summary is
  // a fact about, which a render handed one status cannot see.
  const prevStatusRef = useRef(input.status);
  const lastElapsedRef = useRef(elapsed);
  const lastTokensRef = useRef(input.estimatedTokens);
  const [showComplete, setShowComplete] = useState(false);

  useEffect(() => {
    if (input.status !== 'streaming') return;
    lastElapsedRef.current = elapsed;
    lastTokensRef.current = input.estimatedTokens;
    // Only as the turn STARTS: once it is running the summary is already put
    // away, and clearing it again on every token says nothing new.
    if (prevStatusRef.current !== 'streaming') setShowComplete(false);
  }, [input.status, elapsed, input.estimatedTokens]);

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
    // Never from here: `SESSION_CAPABILITIES.streamHealth` is false, and the
    // status chip under the box is where a session reports its connection.
    stalled: false,
    presence: NO_PRESENCE,
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
