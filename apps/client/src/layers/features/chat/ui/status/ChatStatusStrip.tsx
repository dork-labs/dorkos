import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { PermissionMode } from '@dorkos/shared/types';
import type { SessionActivity } from '@dorkos/shared/session-stream';
import { useElapsedTime } from '@/layers/shared/model';
import { isBypassPermissionMode, TIMING } from '@/layers/shared/lib';
import { DEFAULT_THEME, type IndicatorTheme } from './inference-themes';
import { StripContent } from './StripContent';
import { deriveStripState, formatTokens, type StripState } from './strip-state';
import type { SystemStatusState, OperationProgressState } from '../../model/chat-types';

interface UseStripStateInput {
  status: 'idle' | 'streaming' | 'error';
  streamStartTime: number | null;
  estimatedTokens: number;
  permissionMode: PermissionMode;
  isWaitingForUser: boolean;
  waitingType: 'approval' | 'question';
  operationProgress: OperationProgressState | null;
  systemStatus: SystemStatusState | null;
  activity: SessionActivity | null;
  theme: IndicatorTheme;
}

/** Manage status strip lifecycle and derive the active strip state. */
function useStripState(input: UseStripStateInput): StripState {
  const { formatted: elapsed } = useElapsedTime(
    input.status === 'streaming' ? input.streamStartTime : null
  );

  // `isBypassPermissionMode` (not a literal `'bypassPermissions'` compare):
  // `input.permissionMode` carries whatever id the session's own runtime
  // reports (DOR-851), and `always-allow` — test-mode's bypass mode — is a
  // different literal with the same meaning. A literal compare here missed it
  // and never warned at all on that runtime.
  const isBypass = isBypassPermissionMode(input.permissionMode);

  // Snapshot final values when streaming ends so the complete state can display them
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

  // When streaming transitions to idle with tokens > 0, show the complete state
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

  // Auto-dismiss the post-turn summary
  useEffect(() => {
    if (!showComplete) return;
    const timer = setTimeout(() => setShowComplete(false), TIMING.TURN_COMPLETE_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [showComplete]);

  return deriveStripState({
    status: input.status,
    isWaitingForUser: input.isWaitingForUser,
    waitingType: input.waitingType,
    operationProgress: input.operationProgress,
    systemStatus: input.systemStatus,
    elapsed,
    activity: input.activity,
    tokens: formatTokens(input.estimatedTokens),
    theme: input.theme,
    isBypass,
    showComplete,
    // eslint-disable-next-line react-hooks/refs -- Intentional: snapshot refs read during render for post-stream display
    lastElapsed: lastElapsedRef.current,
    // eslint-disable-next-line react-hooks/refs -- Intentional: snapshot refs read during render for post-stream display
    lastTokens: formatTokens(lastTokensRef.current),
  });
}

interface ChatStatusStripProps {
  status: 'idle' | 'streaming' | 'error';
  streamStartTime: number | null;
  estimatedTokens: number;
  permissionMode?: PermissionMode;
  isWaitingForUser?: boolean;
  waitingType?: 'approval' | 'question';
  operationProgress?: OperationProgressState | null;
  systemStatus: SystemStatusState | null;
  /**
   * What this session is doing right now, from the fleet-wide status stream.
   * Absent while nothing is known — the strip then says only "Working…".
   */
  activity?: SessionActivity | null;
  theme?: IndicatorTheme;
}

/**
 * Unified status strip positioned between MessageList and the chat input.
 *
 * Consolidates InferenceIndicator and SystemStatusZone into a single morphing
 * container using a prioritized state machine. Always visible regardless of
 * scroll position. Collapses to height 0 when idle.
 *
 * While a turn is in flight it names the tool the session is actually running,
 * from the same fleet-wide reading the rest of the cockpit reads — and says
 * plainly that it is working when it does not know.
 *
 * It is also a polite live region, so "Waiting for your approval" reaches someone
 * who cannot see it — the same courtesy the message area, the background task bar,
 * and the tool-approval prompt already extend. `StripContent` hides the ticking
 * parts from it so a state *change* announces and the churn does not.
 */
export function ChatStatusStrip({
  status,
  streamStartTime,
  estimatedTokens,
  permissionMode = 'default',
  isWaitingForUser = false,
  waitingType = 'approval',
  operationProgress = null,
  systemStatus,
  activity = null,
  theme = DEFAULT_THEME,
}: ChatStatusStripProps) {
  const state = useStripState({
    status,
    streamStartTime,
    estimatedTokens,
    permissionMode,
    isWaitingForUser,
    waitingType,
    operationProgress,
    systemStatus,
    activity,
    theme,
  });

  return (
    // Layer 1: Outer height animation — collapses to 0 when idle
    <motion.div
      initial={false}
      animate={{ height: state.type === 'idle' ? 0 : 'auto' }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="overflow-hidden"
      aria-live="polite"
    >
      {/* Layer 2: Inner crossfade — morphs between state types */}
      <AnimatePresence mode="wait">
        <motion.div
          key={state.type}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <StripContent state={state} />
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}
