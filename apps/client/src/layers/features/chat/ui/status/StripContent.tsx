import { useCallback, useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Shield, MessageSquare } from 'lucide-react';
import type { StripState } from './strip-state';

/**
 * What the strip draws for one state.
 *
 * The strip announces itself politely, which puts an extra rule on everything in
 * here: anything that ticks — the rotating verb, the elapsed clock, the token
 * count — is `aria-hidden`, and each state carries one stable sentence instead. A
 * live region that re-reads "2m 15s" every second is worse than silence.
 *
 * @param state - The active strip state.
 */
export function StripContent({ state }: { state: StripState }): ReactNode {
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

/** A turn in flight: the animated glyph, what it is doing, elapsed, and tokens.
 *
 * @internal
 */
function StreamingContent({ state }: { state: Extract<StripState, { type: 'streaming' }> }) {
  const verbColorClass = state.isBypass ? 'text-amber-500/60' : 'text-muted-foreground';
  const iconColorClass = state.isBypass
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
      className="flex items-center gap-1.5 px-4 py-2 text-xs"
      data-testid="chat-status-strip-streaming"
    >
      {/* The one thing worth announcing about this state. The activity label
          below is deliberately NOT announced: it changes every couple of
          seconds while a turn works, and a live region that re-reads it is the
          same churn the elapsed clock was hidden for. */}
      <span className="sr-only">Working</span>

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

      {/* Layer 3: Activity sub-animation — container width animates so the
          elapsed clock slides smoothly when the label's length changes */}
      <motion.span
        aria-hidden="true"
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

      <span aria-hidden="true" className="text-muted-foreground/70 ml-1.5 tabular-nums">
        {state.elapsed}
      </span>
      <span aria-hidden="true" className="text-muted-foreground/60 ml-1.5">
        {state.tokens}
      </span>
    </div>
  );
}

/** The turn has stopped and needs you: an approval or an answer.
 *
 * @internal
 */
function WaitingContent({ state }: { state: Extract<StripState, { type: 'waiting' }> }) {
  const WaitIcon = state.waitingType === 'approval' ? Shield : MessageSquare;
  const waitMessage =
    state.waitingType === 'approval' ? 'Waiting for your approval' : 'Waiting for your answer';

  return (
    <div
      className="flex items-center gap-1.5 px-4 py-2 text-xs"
      data-testid="chat-status-strip-waiting"
    >
      <WaitIcon aria-hidden="true" className="size-3 text-amber-500" />
      <span className="text-amber-600 dark:text-amber-400">{waitMessage}</span>
      <span aria-hidden="true" className="text-muted-foreground/70 ml-1.5 tabular-nums">
        {state.elapsed}
      </span>
    </div>
  );
}

/** A long-running operation such as compaction, with its own progress track.
 *
 * @internal
 */
function OperationProgressContent({
  state,
}: {
  state: Extract<StripState, { type: 'operation-progress' }>;
}) {
  return (
    <div
      className="flex flex-col items-start gap-1.5 px-4 py-2"
      data-testid="chat-status-strip-operation-progress"
      data-determinate={state.determinate}
    >
      <span className="text-muted-foreground/60 text-xs">{state.message}</span>
      <div
        aria-hidden="true"
        className="bg-muted/60 relative h-0.5 w-full overflow-hidden rounded-full"
      >
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

/** An informational runtime event, e.g. a hook the runtime just ran.
 *
 * @internal
 */
function SystemMessageContent({
  state,
}: {
  state: Extract<StripState, { type: 'system-message' }>;
}) {
  const Icon = state.icon;
  return (
    <div
      className="flex items-center gap-1.5 px-4 py-2 text-xs"
      data-testid="chat-status-strip-system-message"
    >
      <Icon aria-hidden="true" className="text-muted-foreground/60 size-3 shrink-0" />
      <span className="text-muted-foreground/60">{state.message}</span>
    </div>
  );
}

/** The finished turn's summary, on its way out.
 *
 * @internal
 */
function CompleteContent({ state }: { state: Extract<StripState, { type: 'complete' }> }) {
  return (
    <div
      className="text-muted-foreground/50 flex items-center gap-1.5 px-4 py-2 text-xs opacity-60"
      data-testid="chat-status-strip-complete"
    >
      <span>{state.elapsed}</span>
      <span aria-hidden="true">&middot;</span>
      <span>{state.tokens}</span>
    </div>
  );
}
