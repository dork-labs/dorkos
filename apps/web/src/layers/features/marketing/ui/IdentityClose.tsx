'use client'

import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import posthog from 'posthog-js'
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants'

interface IdentityCloseProps {
  email: string
}

/** Tribal identity close — origin story, boldness invitation, and contact postscript. */
export function IdentityClose({ email }: IdentityCloseProps) {
  const [revealed, setRevealed] = useState(false)

  return (
    <section id="about" className="py-16 md:py-28 px-8 bg-cream-white">
      <motion.div
        className="max-w-2xl mx-auto text-center"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        <motion.h2
          variants={REVEAL}
          className="text-charcoal text-[28px] md:text-[32px] font-medium tracking-[-0.02em] leading-[1.3] mb-12"
        >
          Built by dorks. For dorks. Run by you.
        </motion.h2>

        <motion.div variants={STAGGER} className="space-y-6 mb-12">
          <motion.p variants={REVEAL} className="text-warm-gray text-[15px] leading-[1.75]">
            Dork was never an insult to us.
          </motion.p>
          <motion.p variants={REVEAL} className="text-warm-gray text-[15px] leading-[1.75]">
            It is what you call someone who cares too much about something most
            people do not care about at all. Someone who names their AI agents.
            Someone who wakes up at 6am to check if the overnight tests passed
            that nobody asked them to check.
          </motion.p>
          <motion.p variants={REVEAL} className="text-warm-gray text-[15px] leading-[1.75]">
            We build at 3am because we cannot stop. Not because someone is paying
            us to. Because the problem is right there and walking away from it
            feels worse than staying up.
          </motion.p>
        </motion.div>

        <motion.p
          variants={REVEAL}
          className="text-warm-gray-light text-sm leading-[1.8] mb-12"
        >
          One developer. Section 8 housing. Library books. Code before graduation.
          <br />
          Thirty million users. An exit in twelve months. Warner Bros. Art Blocks.
          <br />
          And then this &mdash; because the tools that matter most are built by the
          people who need them.
        </motion.p>

        <motion.div variants={STAGGER} className="mb-16">
          <motion.p variants={REVEAL} className="text-warm-gray text-lg leading-[1.7]">
            The people building AI agent teams will outship everyone.
          </motion.p>
          <motion.p variants={REVEAL} className="text-warm-gray-light text-base leading-[1.7]">
            Not because they&apos;re smarter.
          </motion.p>
          <motion.p variants={REVEAL} className="text-charcoal text-xl md:text-[22px] font-semibold tracking-[-0.02em] leading-[1.5]">
            Because their team works while they sleep, never complains,
            <br className="hidden md:inline" />
            {' '}and doesn&apos;t need a Slack channel to feel included.
          </motion.p>
        </motion.div>

        <motion.div variants={REVEAL} className="pt-8" style={{ borderTop: '1px solid rgba(139, 90, 43, 0.08)' }}>
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
                  className="font-mono text-sm text-brand-orange hover:text-brand-green transition-smooth"
                >
                  {email}
                </motion.a>
              ) : (
                <motion.button
                  key="reveal"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  onClick={() => {
                    setRevealed(true)
                    posthog.capture('contact_email_revealed')
                  }}
                  className="font-mono text-sm text-brand-orange hover:text-brand-green transition-smooth"
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
  )
}
