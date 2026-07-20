import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';

import { cn } from '@/layers/shared/lib';
import { TelemetryPayloadBlock } from './TelemetryPayloadBlock';
import { TelemetryPayloadToggle } from './TelemetryPayloadToggle';

/**
 * Progressive-disclosure control for the heartbeat payload: a "See what's sent"
 * toggle that expands to reveal the exact payload ({@link TelemetryPayloadBlock}).
 * Collapsed by default so the payload is one click away rather than a wall of
 * JSON, and identical everywhere it appears (onboarding step, privacy settings).
 * Manages its own open state.
 *
 * @param className - Optional classes for the outer wrapper.
 */
export function TelemetryPayloadDisclosure({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={cn('w-full', className)}>
      <TelemetryPayloadToggle open={open} onToggle={() => setOpen((v) => !v)} />
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="payload"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="pt-2">
              <TelemetryPayloadBlock />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
