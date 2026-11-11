import type { ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { receiptSwapTransition } from '../lib/receipt-swap';

/** Props for {@link BrowserHandoffSlot}. */
export interface BrowserHandoffSlotProps {
  /** The open card and its key, or null when no handoff is open. */
  card: { key: string; node: ReactNode } | null;
  /** The ended handoff's receipt and its key, or null when there is none to show. */
  receipt: { key: string; node: ReactNode } | null;
}

/**
 * The slot a handoff card lives in (DOR-3112). The card comes in as the composer's
 * background task bar does. When it ends, its height collapses while it crossfades
 * with the one-line receipt, so the composer below settles instead of jumping.
 * Under reduced motion every change is instant.
 */
export function BrowserHandoffSlot({ card, receipt }: BrowserHandoffSlotProps) {
  const reducedMotion = useReducedMotion();
  const swap = receiptSwapTransition(reducedMotion);
  return (
    <AnimatePresence>
      {card && (
        <motion.div
          key={card.key}
          data-slot="browser-handoff-slot-card"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, height: 0, transition: swap }}
          transition={reducedMotion ? { duration: 0 } : { duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="overflow-hidden"
        >
          {card.node}
        </motion.div>
      )}
      {!card && receipt && (
        <motion.div
          key={receipt.key}
          data-slot="browser-handoff-slot-receipt"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={swap}
          className="overflow-hidden"
        >
          {receipt.node}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
