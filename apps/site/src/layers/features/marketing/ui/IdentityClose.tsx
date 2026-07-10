'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import posthog from 'posthog-js';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

interface IdentityCloseProps {
  email: string;
}

/** Identity close — origin story, hero turn, and contact postscript. */
export function IdentityClose({ email }: IdentityCloseProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <section id="about" className="bg-cream-white px-8 py-16 md:py-28">
      <motion.div
        className="mx-auto max-w-2xl text-center"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        <motion.h2
          variants={REVEAL}
          className="text-charcoal mb-12 text-[28px] leading-[1.3] font-medium tracking-[-0.02em] md:text-[32px]"
        >
          We built it for ourselves. Now it&apos;s yours.
        </motion.h2>

        <motion.div variants={STAGGER} className="mb-12 space-y-6">
          <motion.p variants={REVEAL} className="text-warm-gray text-[15px] leading-[1.75]">
            DorkOS started as the system we needed. One person, five projects, ten agents in ten
            different windows. We built the coordination layer so we could build more, faster.
          </motion.p>
          <motion.p variants={REVEAL} className="text-warm-gray text-[15px] leading-[1.75]">
            It&apos;s how we ship everything else: one person and a fleet of agents, 44 public
            releases in five months, every decision documented in the open.
          </motion.p>
          <motion.p variants={REVEAL} className="text-warm-gray text-[15px] leading-[1.75]">
            And yes, we named it after ourselves. Dork is what they call someone who cares too much
            about the plumbing. We answer to it. You never have to.
          </motion.p>
        </motion.div>

        <motion.div variants={STAGGER} className="mb-16">
          <motion.p
            variants={REVEAL}
            className="text-warm-gray text-lg leading-[1.7] font-semibold"
          >
            You&apos;ve always had more ideas than hours.
          </motion.p>
          <motion.p
            variants={REVEAL}
            className="text-charcoal text-xl leading-[1.5] font-semibold tracking-[-0.02em] md:text-[22px]"
          >
            That ratio just changed.
          </motion.p>
          <motion.p variants={REVEAL} className="text-warm-gray mt-6 text-sm font-semibold italic">
            &mdash;{' '}
            <a
              href="https://doriancollier.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-brand-orange transition-smooth"
            >
              Dorian
            </a>
          </motion.p>
        </motion.div>

        <motion.div
          variants={REVEAL}
          className="pt-8"
          style={{ borderTop: '1px solid rgba(139, 90, 43, 0.08)' }}
        >
          <div className="inline-flex items-center gap-2">
            <span className="text-warm-gray text-sm">
              Questions, ideas, or just want to say hello &mdash;
            </span>
            <AnimatePresence mode="wait">
              {revealed ? (
                <motion.a
                  key="email"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  href={`mailto:${email}`}
                  className="text-brand-orange hover:text-brand-green transition-smooth font-mono text-sm"
                >
                  {email}
                </motion.a>
              ) : (
                <motion.button
                  key="reveal"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  onClick={() => {
                    setRevealed(true);
                    posthog.capture('contact_email_revealed');
                  }}
                  className="text-brand-orange hover:text-brand-green transition-smooth font-mono text-sm"
                >
                  reveal_email
                  <span className="cursor-blink" aria-hidden="true" />
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </motion.div>
    </section>
  );
}
