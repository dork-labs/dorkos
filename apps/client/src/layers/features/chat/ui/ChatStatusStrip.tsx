import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Shield, MessageSquare, Info, RefreshCw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PermissionMode } from '@dorkos/shared/types';
import { useElapsedTime } from '@/layers/shared/model';
import { DEFAULT_THEME, type IndicatorTheme } from './inference-themes';
import { BYPASS_INFERENCE_VERBS } from './inference-verbs';
import { useRotatingVerb } from '../model/use-rotating-verb';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Discriminated union representing all possible states of the chat status strip. */
export type StripState =
  | { type: 'rate-limited'; countdown: number | null; elapsed: string }
  | { type: 'waiting'; waitingType: 'approval' | 'question'; elapsed: string }
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
  isRateLimited: boolean;
  countdown: number | null;
  isWaitingForUser: boolean;
  waitingType: 'approval' | 'question';
  systemStatus: string | null;
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

/**
 * Maps system message content to a contextual icon.
 *
 * @internal Exported for testing.
 */
export function deriveSystemIcon(message: string): LucideIcon {
  const lower = message.toLowerCase();
  if (lower.includes('compact')) return RefreshCw;
  if (lower.includes('permission')) return Shield;
  return Info;
}

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
 * 1. rate-limited — user needs to know they're waiting
 * 2. waiting-for-user — user action required to continue
 * 3. system-message — SDK operational event, informational
 * 4. streaming — normal inference in progress
 * 5. complete — post-stream summary, auto-dismisses
 * 6. idle — nothing to show
 */
export function deriveStripState(input: StripStateInput): StripState {
  // Priority 1: Rate-limited
  if (input.status === 'streaming' && input.isRateLimited) {
    return { type: 'rate-limited', countdown: input.countdown, elapsed: input.elapsed };
  }

  // Priority 2: Waiting for user
  if (input.status === 'streaming' && input.isWaitingForUser) {
    return { type: 'waiting', waitingType: input.waitingType, elapsed: input.elapsed };
  }

  // Priority 3: System message (shown regardless of streaming status)
  if (input.systemStatus) {
    return {
      type: 'system-message',
      message: input.systemStatus,
      icon: deriveSystemIcon(input.systemStatus),
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
  isRateLimited: boolean;
  rateLimitRetryAfter: number | null;
  systemStatus: string | null;
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

  // Rate-limit countdown: ticks down every second from retryAfter, clears when rate limit resolves
  const [countdown, setCountdown] = useState<number | null>(null);
  useEffect(() => {
    if (!input.isRateLimited || !input.rateLimitRetryAfter) {
      setCountdown(null);
      return;
    }
    setCountdown(Math.ceil(input.rateLimitRetryAfter));
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null || prev <= 1) return null;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [input.isRateLimited, input.rateLimitRetryAfter]);

  return deriveStripState({
    status: input.status,
    isRateLimited: input.isRateLimited,
    countdown,
    isWaitingForUser: input.isWaitingForUser,
    waitingType: input.waitingType,
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

function RateLimitedContent({ state }: { state: Extract<StripState, { type: 'rate-limited' }> }) {
  return (
    <div
      className="flex items-center justify-center gap-1.5 px-4 py-2 text-xs md:justify-start"
      data-testid="chat-status-strip-rate-limited"
    >
      <span className="text-amber-500">&#x23F3;</span>
      <span className="text-amber-600 dark:text-amber-400">
        {state.countdown !== null
          ? `Rate limited \u2014 retrying in ${state.countdown}s`
          : 'Rate limited \u2014 retrying shortly'}
      </span>
      <span className="text-muted-foreground/70 ml-1.5 tabular-nums">{state.elapsed}</span>
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
    case 'rate-limited':
      return <RateLimitedContent state={state} />;
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
  isRateLimited?: boolean;
  rateLimitRetryAfter?: number | null;
  systemStatus: string | null;
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
  isRateLimited = false,
  rateLimitRetryAfter = null,
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
    isRateLimited,
    rateLimitRetryAfter,
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
