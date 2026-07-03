/**
 * Shared inline feedback rows for the connect flows — an honest progress
 * spinner and a retryable error, mirroring the T0 provisioning row so every
 * connect surface reads the same.
 *
 * @module features/runtime-connect/ui/connect-feedback
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check, Loader2 } from 'lucide-react';
import { Button } from '@/layers/shared/ui';

/** Inline progress row: a spinner plus the latest status line. */
export function ConnectProgressRow({ message }: { message: string }) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      className="bg-muted flex items-center gap-2 rounded-lg px-3 py-2.5"
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      data-testid="connect-progress"
    >
      <motion.span
        className="text-muted-foreground inline-flex"
        animate={reducedMotion ? {} : { rotate: 360 }}
        transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
      >
        <Loader2 className="size-3.5" />
      </motion.span>
      <AnimatePresence mode="wait">
        <motion.span
          key={message}
          className="truncate text-xs"
          initial={reducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reducedMotion ? undefined : { opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {message}
        </motion.span>
      </AnimatePresence>
    </motion.div>
  );
}

/** Inline "connected" confirmation shown briefly before the surface flips to Ready. */
export function ConnectedRow({ message = 'Connected' }: { message?: string }) {
  return (
    <div
      className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs text-emerald-500"
      data-testid="connect-connected"
    >
      <Check className="size-3.5" />
      {message}
    </div>
  );
}

/** Inline error row with a retry action, for a failed/timed-out connect. */
export function ConnectErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="space-y-2">
      <p className="text-destructive text-xs" role="alert">
        {message}
      </p>
      <Button size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
