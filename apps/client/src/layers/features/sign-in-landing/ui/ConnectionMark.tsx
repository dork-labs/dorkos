import { motion, useReducedMotion } from 'motion/react';
import { Check, Minus, Plug, X } from 'lucide-react';
import { DorkMark } from '@dorkos/icons/marks';
import { cn, SPRING } from '@/layers/shared/lib';

/** How the join reads: joined, set aside (cancelled or expired), or broken. */
export type ConnectionTone = 'connected' | 'neutral' | 'error';

interface ConnectionMarkProps {
  /** The service's name; its first letter is its tile. Empty when it is not known. */
  serviceName: string;
  /** How the join reads. */
  tone: ConnectionTone;
}

/** The first letter or digit of a name, for its tile, or `undefined` when it has none. */
function monogram(name: string): string | undefined {
  return /[\p{L}\p{N}]/u.exec(name)?.[0].toUpperCase();
}

const BADGE_TONE: Record<ConnectionTone, string> = {
  connected: 'bg-status-success-bg border-status-success-border text-status-success-fg',
  neutral: 'bg-muted border-border text-muted-foreground',
  error: 'bg-status-error-bg border-status-error-border text-status-error-fg',
};

/**
 * The service and DorkOS side by side, joined by a line that draws in and a
 * badge that settles on it: a check when the sign-in finished, a dash when it
 * was cancelled or ran out of time, a cross when it broke. With reduced motion
 * everything is simply there.
 */
export function ConnectionMark({ serviceName, tone }: ConnectionMarkProps) {
  const connected = tone === 'connected';
  const letter = monogram(serviceName);
  const still = useReducedMotion() ?? false;
  const tile =
    'bg-muted text-foreground flex size-12 items-center justify-center rounded-xl border text-lg font-semibold';
  return (
    <div className="flex items-center justify-center" aria-hidden="true">
      <div className={tile}>{letter ?? <Plug className="text-muted-foreground size-5" />}</div>
      <div className="relative mx-1 flex h-12 w-16 items-center">
        <motion.div
          className={cn(
            'w-full origin-left',
            connected ? 'bg-status-success h-px' : 'border-border h-0 border-t border-dashed'
          )}
          initial={still ? false : { scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        />
        <motion.div
          className={cn(
            'absolute top-1/2 left-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border',
            BADGE_TONE[tone]
          )}
          initial={still ? false : { scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={still ? { duration: 0 } : { delay: 0.35, ...SPRING.snap }}
        >
          {tone === 'connected' && <Check className="size-3.5" strokeWidth={3} />}
          {tone === 'neutral' && <Minus className="size-3.5" strokeWidth={3} />}
          {tone === 'error' && <X className="size-3.5" strokeWidth={3} />}
        </motion.div>
      </div>
      <div className={tile}>
        <DorkMark size={22} />
      </div>
    </div>
  );
}
