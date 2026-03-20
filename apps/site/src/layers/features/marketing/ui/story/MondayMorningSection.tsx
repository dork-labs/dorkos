'use client';

import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import { REVEAL, STAGGER, SPRING, VIEWPORT_REPEAT as VIEWPORT } from '../../lib/motion-variants';
import { bootCards } from '../../lib/story-data';
import type { BootCard } from '../../lib/story-data';
import { usePresentationContext } from '../../lib/presentation-context';

interface MondayMorningSectionProps {
  slideId?: string;
}

const BORDER_COLOR: Record<BootCard['color'], string> = {
  orange: 'border-brand-orange',
  blue: 'border-brand-blue',
  purple: 'border-brand-purple',
  green: 'border-brand-green',
  gray: 'border-warm-gray/20',
};

const LABEL_COLOR: Record<BootCard['color'], string> = {
  orange: 'text-brand-orange',
  blue: 'text-brand-blue',
  purple: 'text-brand-purple',
  green: 'text-brand-green',
  gray: 'text-warm-gray-light',
};

/** The "Thursday Morning" boot dashboard — cards appear one by one in presentation mode. */
export function MondayMorningSection({ slideId = 'morning' }: MondayMorningSectionProps) {
  const { isPresent, subStep } = usePresentationContext();

  // In presentation mode, reveal cards one at a time. In normal scroll, show all.
  const visibleCards = isPresent ? bootCards.slice(0, subStep + 1) : bootCards;

  return (
    <section
      className="flex min-h-screen flex-col justify-center bg-[#0f0e0c] px-8 py-16"
      data-slide={slideId}
    >
      <div className="mx-auto w-full max-w-2xl">
        {/* Header */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
          className="mb-8"
        >
          <motion.div
            variants={REVEAL}
            className="text-brand-orange mb-3 font-mono text-[9px] tracking-[0.2em] uppercase"
          >
            A Thursday Morning
          </motion.div>
          <motion.h2
            variants={REVEAL}
            className="text-cream-white mb-2 text-[clamp(22px,3vw,36px)] font-semibold tracking-tight"
          >
            Before you touched anything.
          </motion.h2>
          <motion.p variants={REVEAL} className="text-warm-gray text-sm">
            While you slept, the system ran.
          </motion.p>
        </motion.div>

        {/* Boot cards grid */}
        <LayoutGroup>
          <motion.div layout className="mb-8 grid grid-cols-2 gap-4">
            <AnimatePresence initial={false}>
              {visibleCards.map((card, i) => (
                <motion.div
                  key={card.id}
                  layout
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ ...SPRING, delay: isPresent ? 0 : i * 0.08 }}
                  className={`bg-charcoal rounded-lg border p-5 ${BORDER_COLOR[card.color]}`}
                >
                  <div
                    className={`mb-2 font-mono text-[9px] tracking-[0.12em] uppercase ${LABEL_COLOR[card.color]}`}
                  >
                    {card.label}
                  </div>
                  <div
                    className={`mb-1.5 font-mono text-[18px] font-semibold ${card.urgent ? 'text-brand-orange' : 'text-cream-white'}`}
                  >
                    {card.value}
                  </div>
                  <div className="text-warm-gray-light font-mono text-[9px]">{card.detail}</div>
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>

          {/* Landing line — only shown when all cards are visible */}
          <AnimatePresence>
            {(!isPresent || subStep === bootCards.length - 1) && (
              <motion.div
                layout
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4, delay: 0.2 }}
                className="border-warm-gray/10 border-t pt-5 text-center"
              >
                <p className="text-cream-white text-[15px] font-semibold italic">
                  &ldquo;This isn&apos;t ChatGPT. This is a personal operating system.&rdquo;
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </LayoutGroup>
      </div>
    </section>
  );
}
