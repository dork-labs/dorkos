'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { PhilosophyCard } from './PhilosophyCard';
import type { PhilosophyItem } from '../lib/types';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

interface AboutSectionProps {
  bylineText?: string;
  bylineHref?: string;
  description: string;
  philosophyItems?: PhilosophyItem[];
}

/** Merged About + Origin section with philosophy grid and closing line. */
export function AboutSection({
  bylineText = 'by Dork Labs',
  bylineHref = 'https://github.com/dork-labs/dorkos',
  description,
  philosophyItems = [],
}: AboutSectionProps) {
  return (
    <section id="about" className="bg-cream-white px-8 py-40 text-center">
      <motion.div initial="hidden" whileInView="visible" viewport={VIEWPORT} variants={STAGGER}>
        <motion.span
          variants={REVEAL}
          className="text-2xs text-charcoal mb-16 block font-mono tracking-[0.15em] uppercase"
        >
          About
        </motion.span>

        <motion.p
          variants={REVEAL}
          className="text-charcoal mx-auto mb-6 max-w-3xl text-[32px] leading-[1.3] font-medium tracking-[-0.02em]"
        >
          DorkOS is an autonomous agent operating system{' '}
          <Link
            href={bylineHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-orange hover:text-brand-green transition-smooth"
          >
            {bylineText}
          </Link>
          .
        </motion.p>

        <motion.p
          variants={REVEAL}
          className="text-warm-gray mx-auto mb-20 max-w-xl text-base leading-[1.7]"
        >
          {description}
        </motion.p>

        {philosophyItems.length > 0 && (
          <motion.div
            variants={STAGGER}
            className="mx-auto mb-16 grid max-w-4xl grid-cols-1 gap-12 md:grid-cols-2 lg:grid-cols-4"
          >
            {philosophyItems.map((item) => (
              <motion.div key={item.number} variants={REVEAL}>
                <PhilosophyCard item={item} />
              </motion.div>
            ))}
          </motion.div>
        )}

        <motion.p variants={REVEAL} className="text-warm-gray-light text-lg leading-[1.7] italic">
          The name is playful. The tool is serious.
        </motion.p>
      </motion.div>
    </section>
  );
}
