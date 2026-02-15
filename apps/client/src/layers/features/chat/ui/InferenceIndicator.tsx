import { useMemo, useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Shield, MessageSquare } from 'lucide-react';
import { useElapsedTime } from '@/layers/shared/lib';
import { useRotatingVerb } from '../model/use-rotating-verb';
import { DEFAULT_THEME, type IndicatorTheme } from './inference-themes';
import { BYPASS_INFERENCE_VERBS } from './inference-verbs';
import type { PermissionMode } from '@dorkos/shared/types';

interface InferenceIndicatorProps {
  status: 'idle' | 'streaming' | 'error';
  streamStartTime: number | null;
  estimatedTokens: number;
  theme?: IndicatorTheme;
  permissionMode?: PermissionMode;
  isWaitingForUser?: boolean;
  waitingType?: 'approval' | 'question';
}

function formatTokens(count: number): string {
  if (count >= 1000) {
    return `~${(count / 1000).toFixed(1)}k tokens`;
  }
  return `~${Math.round(count)} tokens`;
}

export function InferenceIndicator({
  status,
  streamStartTime,
  estimatedTokens,
  theme = DEFAULT_THEME,
  permissionMode = 'default',
  isWaitingForUser,
  waitingType,
}: InferenceIndicatorProps) {
  const verbs = useMemo(() => {
    if (permissionMode === 'bypassPermissions') {
      return [...theme.verbs, ...BYPASS_INFERENCE_VERBS];
    }
    return theme.verbs;
  }, [theme.verbs, permissionMode]);

  const { formatted: elapsed } = useElapsedTime(
    status === 'streaming' ? streamStartTime : null
  );
  const { verb, key } = useRotatingVerb(verbs, theme.verbInterval);

  const isBypassVerb = (BYPASS_INFERENCE_VERBS as readonly string[]).includes(verb);

  // Snapshot final values when streaming ends so the summary persists
  const lastElapsedRef = useRef(elapsed);
  const lastTokensRef = useRef(estimatedTokens);
  const [showComplete, setShowComplete] = useState(false);

  useEffect(() => {
    if (status === 'streaming') {
      lastElapsedRef.current = elapsed;
      lastTokensRef.current = estimatedTokens;
      setShowComplete(false);
    }
  }, [status, elapsed, estimatedTokens]);

  // When streaming stops with tokens, show the complete state
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (prevStatusRef.current === 'streaming' && status === 'idle' && lastTokensRef.current > 0) {
      setShowComplete(true);
    }
    prevStatusRef.current = status;
  }, [status]);

  // Null render: nothing to show
  if (status === 'idle' && !showComplete) {
    return null;
  }

  // Complete state: compact summary that persists
  if (status === 'idle' && showComplete) {
    return (
      <motion.div
        initial={{ opacity: 1 }}
        animate={{ opacity: 0.6 }}
        transition={{ duration: 0.15 }}
        className="flex items-baseline gap-1.5 px-4 py-2 text-3xs text-muted-foreground/50"
        data-testid="inference-indicator-complete"
      >
        <span>{lastElapsedRef.current}</span>
        <span aria-hidden="true">&middot;</span>
        <span>{formatTokens(lastTokensRef.current)}</span>
      </motion.div>
    );
  }

  // Waiting-for-user state: takes priority over normal streaming indicator
  if (status === 'streaming' && isWaitingForUser) {
    const WaitIcon = waitingType === 'approval' ? Shield : MessageSquare;
    const waitMessage = waitingType === 'approval'
      ? 'Waiting for your approval'
      : 'Waiting for your answer';

    return (
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="flex items-baseline gap-1.5 px-4 py-2 text-2xs"
        data-testid="inference-indicator-waiting"
      >
        <WaitIcon className="size-3 text-amber-500" />
        <span className="text-amber-600 dark:text-amber-400">{waitMessage}</span>
        <span className="text-muted-foreground/70 tabular-nums ml-1.5">{elapsed}</span>
      </motion.div>
    );
  }

  // Streaming state
  const icon = isBypassVerb ? '☠' : theme.icon;
  const verbColorClass = isBypassVerb ? 'text-amber-500/60' : 'text-muted-foreground';
  const iconColorClass = isBypassVerb ? 'text-amber-500/70 font-bold' : 'text-muted-foreground font-bold';

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="flex items-baseline gap-1.5 px-4 py-2 text-2xs"
      data-testid="inference-indicator-streaming"
    >
      {/* Shimmer icon */}
      <span
        aria-hidden="true"
        className={iconColorClass}
        style={
          theme.iconAnimation
            ? { animation: `${theme.iconAnimation} 2s ease-in-out infinite` }
            : undefined
        }
      >
        {icon}
      </span>

      {/* Rotating verb with crossfade */}
      <span className={`relative inline-flex min-w-[140px] ${verbColorClass}`}>
        <AnimatePresence mode="wait">
          <motion.span
            key={key}
            initial={{ opacity: 0, y: 2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -2 }}
            transition={{ duration: 0.3 }}
          >
            {verb}
          </motion.span>
        </AnimatePresence>
      </span>

      {/* Elapsed time */}
      <span className="text-muted-foreground/70 tabular-nums ml-1.5">{elapsed}</span>

      {/* Token estimate */}
      <span className="text-muted-foreground/60 ml-1.5">{formatTokens(estimatedTokens)}</span>
    </motion.div>
  );
}
