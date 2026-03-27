import { useState, useEffect } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/layers/shared/lib';

/** Time after mount at which each step becomes active (milliseconds). */
const STEP_THRESHOLDS_MS = [0, 500, 1200] as const;

interface Step {
  label: string;
  thresholdMs: number;
}

const STEPS: Step[] = [
  { label: 'Initialising ngrok agent', thresholdMs: STEP_THRESHOLDS_MS[0] },
  { label: 'Opening secure tunnel', thresholdMs: STEP_THRESHOLDS_MS[1] },
  { label: 'Registering public URL', thresholdMs: STEP_THRESHOLDS_MS[2] },
];

/**
 * Stagger container — orchestrates sequential entrance of step rows.
 * staggerChildren: 0.15 gives each step a 150ms offset.
 */
const stepsContainerVariants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.15 },
  },
} as const;

/** Each step row fades and slides up from 8px below. */
const stepRowVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 320, damping: 28 } },
} as const;

/** Checkmark springs in from 50% scale — snappy, no visible bounce. */
const checkmarkVariants = {
  initial: { scale: 0.5, opacity: 0 },
  animate: { scale: 1, opacity: 1 },
} as const;

/** Spring transition for the checkmark scale-in. */
const checkmarkTransition = { type: 'spring', stiffness: 400, damping: 30 } as const;

/** Props for the connecting view shown while tunnel is starting. */
export interface TunnelConnectingProps {
  // Self-contained — derives step state from elapsed time since mount.
}

/** Connecting view — shown while the tunnel is being established.
 *
 * Renders three progress steps that activate sequentially based on elapsed
 * time since mount: immediately, after 500 ms, and after 1 200 ms.
 * Each step shows a spinner while active and a checkmark when superseded.
 */
export function TunnelConnecting(_props: TunnelConnectingProps) {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();

    // Schedule state updates at each threshold so steps appear at the right time.
    const timers = STEP_THRESHOLDS_MS.map((threshold) =>
      setTimeout(() => {
        setElapsedMs(Date.now() - startedAt);
      }, threshold)
    );

    return () => {
      timers.forEach(clearTimeout);
    };
  }, []);

  return (
    <motion.div
      className="space-y-3 py-2"
      data-testid="tunnel-connecting"
      variants={stepsContainerVariants}
      initial="hidden"
      animate="show"
    >
      {STEPS.map((step, index) => {
        const isReached = elapsedMs >= step.thresholdMs;
        // A step is "done" once the next step has become active.
        const nextThreshold = STEPS[index + 1]?.thresholdMs ?? Infinity;
        const isDone = elapsedMs >= nextThreshold;
        const isActive = isReached && !isDone;

        return (
          <motion.div
            key={step.label}
            variants={stepRowVariants}
            className={cn(
              'flex items-center gap-3 text-sm transition-opacity duration-300',
              isReached ? 'opacity-100' : 'opacity-0'
            )}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              <AnimatePresence mode="wait">
                {isDone ? (
                  <motion.span
                    key="check"
                    variants={checkmarkVariants}
                    initial="initial"
                    animate="animate"
                    exit={{ scale: 0.5, opacity: 0 }}
                    transition={checkmarkTransition}
                    className="inline-flex"
                  >
                    <Check className="text-muted-foreground size-4" />
                  </motion.span>
                ) : isActive ? (
                  <motion.span
                    key="spinner"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="inline-flex"
                  >
                    <Loader2 className="text-muted-foreground size-4 animate-spin" />
                  </motion.span>
                ) : null}
              </AnimatePresence>
            </span>
            <span
              className={cn(
                'transition-colors duration-200',
                isDone ? 'text-muted-foreground' : 'text-foreground'
              )}
            >
              {step.label}
            </span>
          </motion.div>
        );
      })}
    </motion.div>
  );
}
