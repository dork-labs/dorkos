import { AlertCircle, RefreshCw } from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/layers/shared/ui';
import { friendlyErrorMessage } from '../lib/tunnel-utils';

/**
 * Horizontal shake animation — plays on mount to signal a connection failure.
 * Keyframes: center → left → right → slight left → center.
 * Note: not `as const` — Motion's TargetAndTransition requires mutable arrays for keyframes.
 */
const shakeVariants = {
  initial: { x: 0 },
  animate: { x: [0, -2, 2, -1, 0] },
};

/** Shake transition — quick, tension-release feel with no spring overshoot. */
const shakeTransition = { duration: 0.35, ease: 'easeInOut' } as const;

/** Props for the error view shown when tunnel connection fails. */
export interface TunnelErrorProps {
  error: string;
  onRetry: () => void;
}

/** Error view — shown when the tunnel fails to connect. */
export function TunnelError({ error, onRetry }: TunnelErrorProps) {
  const message = friendlyErrorMessage(error);

  return (
    <motion.div
      data-testid="tunnel-error"
      className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950/30"
      variants={shakeVariants}
      initial="initial"
      animate="animate"
      transition={shakeTransition}
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm font-medium text-red-800 dark:text-red-200">Connection failed</p>
          <p className="text-xs text-red-700 dark:text-red-300">{message}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="border-red-300 text-red-700 hover:bg-red-100 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/50"
          >
            <RefreshCw className="mr-1.5 size-3.5" />
            Try again
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
