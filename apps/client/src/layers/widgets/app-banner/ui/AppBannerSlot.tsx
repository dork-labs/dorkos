import { AnimatePresence, motion } from 'motion/react';

import type { BannerDescriptor } from '../model/banner-descriptor';

/**
 * The single global banner slot. Ranks the eligible {@link BannerDescriptor}s by
 * priority and renders only the highest — the system shows one standing banner at
 * a time, never a stack. Swaps are exit-before-enter (`mode="wait"`) so a
 * higher-priority banner cleanly replaces a lower one, and the row collapses to
 * nothing when no banner is eligible.
 *
 * @param descriptors - Eligible banner descriptors (already filtered by their feature hooks).
 */
export function AppBannerSlot({ descriptors }: { descriptors: BannerDescriptor[] }) {
  const winner = descriptors.reduce<BannerDescriptor | null>(
    (best, d) => (best === null || d.priority > best.priority ? d : best),
    null
  );

  return (
    <AnimatePresence mode="wait" initial={false}>
      {winner && (
        <motion.div
          key={winner.id}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
          className="shrink-0 overflow-hidden"
        >
          {winner.render()}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
