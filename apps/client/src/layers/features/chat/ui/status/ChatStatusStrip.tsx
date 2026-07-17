import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Shield, MessageSquare, Info } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PermissionMode } from '@dorkos/shared/types';
import { useElapsedTime } from '@/layers/shared/model';
import { DEFAULT_THEME, type IndicatorTheme } from './inference-themes';
import { BYPASS_INFERENCE_VERBS } from './inference-verbs';
import { useRotatingVerb } from '../../model/use-rotating-verb';
import type { SystemStatusState, OperationProgressState } from '../../model/chat-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Discriminated union representing all possible states of the chat status strip. */
export type StripState =
  | { type: 'waiting'; waitingType: 'approval' | 'question'; elapsed: string }
  | {
      type: 'operation-progress';
      message: string;
      determinate: boolean;
      percent: number | null;
    }
  | { type: 'system-message'; message: string; icon: LucideIcon }
  | {
      type: 'streaming';
      verb: string;
      verbKey: string;
      elapsed: string;
      tokens: string;
      icon: string;
      iconAnimation: string | null;
      isBypassVerb: boolean;
    }
  | { type: 'complete'; elapsed: string; tokens: string }
  | { type: 'idle' };

/** Input shape for the deriveStripState pure function. */
export interface StripStateInput {
  status: 'idle' | 'streaming' | 'error';
  isWaitingForUser: boolean;
  waitingType: 'approval' | 'question';
  operationProgress: OperationProgressState | null;
  systemStatus: SystemStatusState | null;
  elapsed: string;
  verb: string;
  verbKey: string;
  tokens: string;
  theme: IndicatorTheme;
  isBypassVerb: boolean;
  showComplete: boolean;
  lastElapsed: string;
  lastTokens: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Format a token count for display (e.g. 3200 -> "~3.2k tokens"). */
export function formatTokens(count: number): string {
  if (count >= 1000) {
    return `~${(count / 1000).toFixed(1)}k tokens`;
  }
  return `~${Math.round(count)} tokens`;
}

/**
 * Derive the active strip state from raw session inputs. Pure function — no React.
 *
 * Priority stack (first match wins):
 * 1. waiting-for-user — user action required to continue
 * 2. operation-progress — a long-running operation (e.g. compaction) is running
 * 3. system-message — runtime operational event (e.g. a hook), informational
 * 4. streaming — normal inference in progress
 * 5. complete — post-stream summary, auto-dismisses
 * 6. idle — nothing to show
 */
export function deriveStripState(input: StripStateInput): StripState {
  // Priority 1: Waiting for user
  if (input.status === 'streaming' && input.isWaitingForUser) {
    return { type: 'waiting', waitingType: input.waitingType, elapsed: input.elapsed };
  }

  // Priority 2: Operation progress (compaction) — the structured, runtime-agnostic
  // progress treatment (DOR-110), shown regardless of streaming status. The
  // producer supplies the label copy, so there is no status string to match.
  if (input.operationProgress) {
    const { message, determinate, percent } = input.operationProgress;
    return {
      type: 'operation-progress',
      message: message ?? 'Working…',
      determinate,
      percent: percent ?? null,
    };
  }

  // Priority 3: System message (shown regardless of streaming status)
  if (input.systemStatus) {
    return {
      type: 'system-message',
      message: input.systemStatus.message,
      icon: Info,
    };
  }

  // Priority 4: Streaming
  if (input.status === 'streaming') {
    return {
      type: 'streaming',
      verb: input.verb,
      verbKey: input.verbKey,
      elapsed: input.elapsed,
      tokens: input.tokens,
      icon: input.isBypassVerb ? '\u2620' : input.theme.icon,
      iconAnimation: input.isBypassVerb ? null : input.theme.iconAnimation,
      isBypassVerb: input.isBypassVerb,
    };
  }

  // Priority 5: Complete (auto-dismisses after 8s)
  if (input.showComplete) {
    return { type: 'complete', elapsed: input.lastElapsed, tokens: input.lastTokens };
  }

  // Priority 6: Idle
  return { type: 'idle' };
}

// ---------------------------------------------------------------------------
// useStripState hook
// ---------------------------------------------------------------------------

interface UseStripStateInput {
  status: 'idle' | 'streaming' | 'error';
  streamStartTime: number | null;
  estimatedTokens: number;
  permissionMode: PermissionMode;
  isWaitingForUser: boolean;
  waitingType: 'approval' | 'question';
  operationProgress: OperationProgressState | null;
  systemStatus: SystemStatusState | null;
  theme: IndicatorTheme;
}

/** Manage status strip lifecycle and derive the active strip state. */
function useStripState(input: UseStripStateInput): StripState {
  const verbs = useMemo(() => {
    if (input.permissionMode === 'bypassPermissions') {
      return [...input.theme.verbs, ...BYPASS_INFERENCE_VERBS];
    }
    return input.theme.verbs;
  }, [input.theme.verbs, input.permissionMode]);

  const { formatted: elapsed } = useElapsedTime(
    input.status === 'streaming' ? input.streamStartTime : null
  );

  const { verb, key: verbKey } = useRotatingVerb(verbs, input.theme.verbInterval);

  const isBypassVerb = (BYPASS_INFERENCE_VERBS as readonly string[]).includes(verb);

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

  // Auto-dismiss complete state after 8 seconds
  useEffect(() => {
    if (!showComplete) return;
    const timer = setTimeout(() => setShowComplete(false), 8000);
    return () => clearTimeout(timer);
  }, [showComplete]);

  return deriveStripState({
    status: input.status,
    isWaitingForUser: input.isWaitingForUser,
    waitingType: input.waitingType,
    operationProgress: input.operationProgress,
    systemStatus: input.systemStatus,
    elapsed,
    verb,
    verbKey,
    tokens: formatTokens(input.estimatedTokens),
    theme: input.theme,
    isBypassVerb,
    showComplete,
    // eslint-disable-next-line react-hooks/refs -- Intentional: snapshot refs read during render for post-stream display
    lastElapsed: lastElapsedRef.current,
    // eslint-disable-next-line react-hooks/refs -- Intentional: snapshot refs read during render for post-stream display
    lastTokens: formatTokens(lastTokensRef.current),
  });
}

// ---------------------------------------------------------------------------
// Per-state renderers
// ---------------------------------------------------------------------------

function StreamingContent({ state }: { state: Extract<StripState, { type: 'streaming' }> }) {
  const verbColorClass = state.isBypassVerb ? 'text-amber-500/60' : 'text-muted-foreground';
  const iconColorClass = state.isBypassVerb
    ? 'text-amber-500/70 font-bold'
    : 'text-muted-foreground font-bold';

  // Animate verb container width so elapsed/tokens slide smoothly when verb length changes
  const [verbWidth, setVerbWidth] = useState(140);
  const verbRef = useCallback((node: HTMLSpanElement | null) => {
    if (node && node.offsetWidth > 0) {
      setVerbWidth(node.offsetWidth);
    }
  }, []);

  return (
    <div
      className="flex items-center justify-center gap-1.5 px-4 py-2 text-xs md:justify-start"
      data-testid="chat-status-strip-streaming"
    >
      <span
        aria-hidden="true"
        className={iconColorClass}
        style={
          state.iconAnimation
            ? { animation: `${state.iconAnimation} 2s ease-in-out infinite` }
            : undefined
        }
      >
        {state.icon}
      </span>

      {/* Layer 3: Verb sub-animation — container width animates for smooth repositioning */}
      <motion.span
        className={`relative inline-block h-4 ${verbColorClass}`}
        animate={{ width: verbWidth }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
      >
        <AnimatePresence mode="wait">
          <motion.span
            ref={verbRef}
            key={state.verbKey}
            className="absolute top-0 left-0 whitespace-nowrap"
            initial={{ opacity: 0, y: 2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -2 }}
            transition={{ duration: 0.3 }}
          >
            {state.verb}
          </motion.span>
        </AnimatePresence>
      </motion.span>

      <span className="text-muted-foreground/70 ml-1.5 tabular-nums">{state.elapsed}</span>
      <span className="text-muted-foreground/60 ml-1.5">{state.tokens}</span>
    </div>
  );
}

function WaitingContent({ state }: { state: Extract<StripState, { type: 'waiting' }> }) {
  const WaitIcon = state.waitingType === 'approval' ? Shield : MessageSquare;
  const waitMessage =
    state.waitingType === 'approval' ? 'Waiting for your approval' : 'Waiting for your answer';

  return (
    <div
      className="flex items-center justify-center gap-1.5 px-4 py-2 text-xs md:justify-start"
      data-testid="chat-status-strip-waiting"
    >
      <WaitIcon className="size-3 text-amber-500" />
      <span className="text-amber-600 dark:text-amber-400">{waitMessage}</span>
      <span className="text-muted-foreground/70 ml-1.5 tabular-nums">{state.elapsed}</span>
    </div>
  );
}

function OperationProgressContent({
  state,
}: {
  state: Extract<StripState, { type: 'operation-progress' }>;
}) {
  return (
    <div
      className="flex flex-col gap-1.5 px-4 py-2 md:items-start"
      data-testid="chat-status-strip-operation-progress"
      data-determinate={state.determinate}
    >
      <span className="text-muted-foreground/60 text-xs">{state.message}</span>
      <div className="bg-muted/60 relative h-0.5 w-full overflow-hidden rounded-full">
        {state.determinate ? (
          <motion.div
            className="bg-muted-foreground/50 absolute inset-y-0 left-0 rounded-full"
            initial={false}
            animate={{ width: `${state.percent ?? 0}%` }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
          />
        ) : (
          // Indeterminate: a short segment sweeps the track — parity with the
          // runtime's own indeterminate bar when no completion fraction exists.
          <motion.div
            className="bg-muted-foreground/50 absolute inset-y-0 w-1/3 rounded-full"
            animate={{ x: ['-100%', '400%'] }}
            transition={{ duration: 1.4, ease: 'easeInOut', repeat: Infinity }}
          />
        )}
      </div>
    </div>
  );
}

function SystemMessageContent({
  state,
}: {
  state: Extract<StripState, { type: 'system-message' }>;
}) {
  const Icon = state.icon;
  return (
    <div
      className="flex items-center justify-center gap-1.5 px-4 py-2 text-xs md:justify-start"
      data-testid="chat-status-strip-system-message"
    >
      <Icon className="text-muted-foreground/60 size-3 shrink-0" />
      <span className="text-muted-foreground/60">{state.message}</span>
    </div>
  );
}

function CompleteContent({ state }: { state: Extract<StripState, { type: 'complete' }> }) {
  return (
    <div
      className="text-muted-foreground/50 flex items-center justify-center gap-1.5 px-4 py-2 text-xs opacity-60 md:justify-start"
      data-testid="chat-status-strip-complete"
    >
      <span>{state.elapsed}</span>
      <span aria-hidden="true">&middot;</span>
      <span>{state.tokens}</span>
    </div>
  );
}

function renderContent(state: StripState): React.ReactNode {
  switch (state.type) {
    case 'streaming':
      return <StreamingContent state={state} />;
    case 'waiting':
      return <WaitingContent state={state} />;
    case 'operation-progress':
      return <OperationProgressContent state={state} />;
    case 'system-message':
      return <SystemMessageContent state={state} />;
    case 'complete':
      return <CompleteContent state={state} />;
    case 'idle':
      return null;
  }
}

// ---------------------------------------------------------------------------
// ChatStatusStrip component
// ---------------------------------------------------------------------------

interface ChatStatusStripProps {
  status: 'idle' | 'streaming' | 'error';
  streamStartTime: number | null;
  estimatedTokens: number;
  permissionMode?: PermissionMode;
  isWaitingForUser?: boolean;
  waitingType?: 'approval' | 'question';
  operationProgress?: OperationProgressState | null;
  systemStatus: SystemStatusState | null;
  theme?: IndicatorTheme;
}

/**
 * Unified status strip positioned between MessageList and the chat input.
 *
 * Consolidates InferenceIndicator and SystemStatusZone into a single morphing
 * container using a prioritized state machine. Always visible regardless of
 * scroll position. Collapses to height 0 when idle.
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
    theme,
  });

  return (
    // Layer 1: Outer height animation — collapses to 0 when idle
    <motion.div
      initial={false}
      animate={{ height: state.type === 'idle' ? 0 : 'auto' }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="overflow-hidden"
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
          {renderContent(state)}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}
