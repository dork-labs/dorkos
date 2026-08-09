import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { PromoPlacement } from '../model/promo-types';
import { usePromoSlot } from '../model/use-promo-slot';
import { PromoCard } from './PromoCard';

const sectionEntrance = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { duration: 0.2, ease: [0, 0, 0.2, 1] },
} as const;

const staggerContainer = {
  animate: { transition: { staggerChildren: 0.04 } },
} as const;

interface PromoSlotProps {
  /** Which placement slot to render. */
  placement: PromoPlacement;
  /** Maximum number of promo cards to show. */
  maxUnits: number;
}

/**
 * Renders promo cards for a given placement slot — a compact vertical stack.
 * Zero DOM when no promos qualify.
 *
 * Both surviving placements are sidebars, so there is one layout. The
 * "Discover" grid went with the dashboard it lived on (team-room-home task 1.5);
 * its successor on home is the quiet-state suggestion, not another slot.
 */
export function PromoSlot({ placement, maxUnits }: PromoSlotProps) {
  const promos = usePromoSlot(placement, maxUnits);
  const shouldReduceMotion = useReducedMotion();

  const motionProps = shouldReduceMotion ? {} : sectionEntrance;

  return (
    <AnimatePresence initial={false}>
      {promos.length > 0 && (
        <motion.section
          key="promo-slot"
          data-slot="promo-slot"
          {...motionProps}
          className="overflow-hidden"
        >
          <motion.div
            variants={shouldReduceMotion ? undefined : staggerContainer}
            initial="initial"
            animate="animate"
            className="space-y-2"
          >
            {promos.map((promo) => (
              <PromoCard key={promo.id} promo={promo} />
            ))}
          </motion.div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
