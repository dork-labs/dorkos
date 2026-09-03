import { AlertCircle, RefreshCw } from 'lucide-react';
import { motion } from 'motion/react';
import { Button, LinkifiedText } from '@/layers/shared/ui';
import { friendlyErrorMessage } from '@/layers/entities/tunnel';

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

/**
 * Error view — shown when the tunnel fails to connect.
 *
 * `role="alert"` because this appears in place of whatever the person was
 * looking at, in response to something they just did, and a screen reader has no
 * other way to learn that. It needed saying twice as much once the state machine
 * stopped erasing this view a paint after it rendered (DOR-1739).
 *
 * Colours come from the `destructive` token rather than the red palette, so the
 * panel follows the theme the way every other error surface in the app does.
 */
export function TunnelError({ error, onRetry }: TunnelErrorProps) {
  const message = friendlyErrorMessage(error);

  return (
    <motion.div
      data-testid="tunnel-error"
      role="alert"
      className="border-destructive/30 bg-destructive/5 rounded-lg border p-4"
      variants={shakeVariants}
      initial="initial"
      animate="animate"
      transition={shakeTransition}
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="text-destructive mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-destructive text-sm font-medium">Tunnel failed</p>
          <p className="text-destructive/90 text-xs">
            <LinkifiedText text={message} />
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <RefreshCw className="mr-1.5 size-3.5" />
            Try again
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
