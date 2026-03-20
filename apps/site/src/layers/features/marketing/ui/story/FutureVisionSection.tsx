'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT_REPEAT as VIEWPORT } from '../../lib/motion-variants';
import { futureCards } from '../../lib/story-data';
import type { FutureCard } from '../../lib/story-data';

interface FutureVisionSectionProps {
  slideId?: string;
}

const LABEL_COLOR: Record<FutureCard['color'], string> = {
  orange: 'text-brand-orange',
  blue: 'text-brand-blue',
  green: 'text-brand-green',
};

/**
 * Permanent-page-only section. Hidden in ?present=true via CSS.
 * Shows where DorkOS is heading: autonomous -> connected -> commerce.
 */
export function FutureVisionSection({ slideId = 'vision' }: FutureVisionSectionProps) {
  return (
    <section className="bg-cream-secondary px-8 py-16" data-future-vision data-slide={slideId}>
      <div className="mx-auto max-w-3xl">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
          className="mb-10"
        >
          <motion.div
            variants={REVEAL}
            className="text-brand-orange mb-3 font-mono text-[9px] tracking-[0.2em] uppercase"
          >
            Where This Is Going
          </motion.div>
          <motion.h2
            variants={REVEAL}
            className="text-charcoal text-[clamp(20px,2.5vw,28px)] font-semibold tracking-tight"
          >
            The next layer is already building.
          </motion.h2>
        </motion.div>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
          className="grid grid-cols-1 gap-4 sm:grid-cols-3"
        >
          {futureCards.map((card) => (
            <motion.div key={card.id} variants={REVEAL} className="bg-cream-primary rounded-lg p-5">
              <div
                className={`mb-2 font-mono text-[9px] tracking-[0.1em] uppercase ${LABEL_COLOR[card.color]}`}
              >
                {card.label}
              </div>
              <h3 className="text-charcoal mb-2 text-[13px] font-semibold">{card.title}</h3>
              <p className="text-warm-gray text-[11px] leading-relaxed">{card.description}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
