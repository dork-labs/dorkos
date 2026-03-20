'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

/** Final page close — the boot sequence completes. */
export function TheClose() {
  return (
    <section className="bg-cream-primary relative px-8 py-14 md:py-24">
      {/* Subtle graph-paper callback — matching the Hero */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `
            linear-gradient(to right, rgba(139, 90, 43, 0.07) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(139, 90, 43, 0.07) 1px, transparent 1px)
          `,
          backgroundSize: '32px 32px',
          maskImage:
            'linear-gradient(to bottom, transparent 0%, black 30%, black 70%, transparent 100%)',
          WebkitMaskImage:
            'linear-gradient(to bottom, transparent 0%, black 30%, black 70%, transparent 100%)',
        }}
      />

      <motion.div
        className="relative z-10 mx-auto max-w-xl text-center"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        <motion.p
          variants={REVEAL}
          className="text-warm-gray mb-6 text-lg leading-[1.5] md:text-xl"
        >
          Your agents are ready. Give them the night.
        </motion.p>

        <motion.p
          variants={REVEAL}
          className="text-brand-orange mb-10 font-mono text-[48px] leading-none font-bold tracking-[-0.03em] md:text-[72px]"
        >
          Ready
          <span className="cursor-blink" aria-hidden="true" />.
        </motion.p>

        <motion.div variants={REVEAL}>
          <Link
            href="https://www.npmjs.com/package/dorkos"
            target="_blank"
            rel="noopener noreferrer"
            className="marketing-btn hidden items-center gap-2 lg:inline-flex"
            style={{ background: '#E85D04', color: '#FFFEFB' }}
          >
            npm install -g dorkos
          </Link>
          <Link
            href="/docs/getting-started/quickstart"
            className="marketing-btn inline-flex items-center gap-2 lg:hidden"
            style={{ background: '#E85D04', color: '#FFFEFB' }}
          >
            Get started
          </Link>
        </motion.div>
      </motion.div>
    </section>
  );
}
