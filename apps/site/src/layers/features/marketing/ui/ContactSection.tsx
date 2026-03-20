'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import posthog from 'posthog-js';

interface ContactSectionProps {
  email: string;
  promptText?: string;
}

export function ContactSection({
  email,
  promptText = 'Have feedback, want to contribute, or just say hello?',
}: ContactSectionProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <section id="contact" className="bg-cream-secondary px-8 py-32">
      <div className="mx-auto max-w-md text-center">
        <span className="text-2xs text-brand-orange mb-10 block font-mono tracking-[0.15em] uppercase">
          Contact
        </span>

        <p className="text-warm-gray mb-10 text-lg leading-[1.7]">{promptText}</p>

        {/* Terminal-style command */}
        <div className="inline-flex items-center justify-center gap-2">
          <span className="text-warm-gray-light font-mono text-lg select-none">&gt;</span>
          <AnimatePresence mode="wait">
            {revealed ? (
              <motion.a
                key="email"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                href={`mailto:${email}`}
                className="text-brand-orange hover:text-brand-green transition-smooth inline-flex items-center font-mono text-lg tracking-[0.02em]"
              >
                {email}
                <span className="cursor-blink" aria-hidden="true" />
              </motion.a>
            ) : (
              <motion.button
                key="reveal"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                onClick={() => {
                  setRevealed(true);
                  posthog.capture('contact_email_revealed');
                }}
                className="text-brand-orange hover:text-brand-green transition-smooth inline-flex items-center font-mono text-lg tracking-[0.02em]"
              >
                <span>reveal_email</span>
                <span className="cursor-blink" aria-hidden="true" />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}
