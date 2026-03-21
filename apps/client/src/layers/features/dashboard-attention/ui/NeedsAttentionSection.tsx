import { AnimatePresence, motion } from 'motion/react';
import { useAttentionItems } from '../model/use-attention-items';
import { AttentionItemRow } from './AttentionItem';

const conditionalSection = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { duration: 0.25, ease: [0, 0, 0.2, 1] },
} as const;

const staggerContainer = {
  animate: { transition: { staggerChildren: 0.04 } },
} as const;

/**
 * Conditional attention section that renders zero DOM when empty.
 * Animates in when attention items appear, animates out when resolved.
 * Items are sourced from stalled sessions, failed Pulse runs, dead letters, and offline agents.
 */
export function NeedsAttentionSection() {
  const items = useAttentionItems();

  return (
    <AnimatePresence initial={false}>
      {items.length > 0 && (
        <motion.section key="attention" {...conditionalSection} className="overflow-hidden">
          <h2 className="mb-3 text-xs font-medium tracking-widest text-amber-600 uppercase dark:text-amber-500">
            Needs Attention
          </h2>
          <motion.div variants={staggerContainer} initial="initial" animate="animate">
            {items.slice(0, 8).map((item) => (
              <AttentionItemRow key={item.id} item={item} />
            ))}
          </motion.div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
