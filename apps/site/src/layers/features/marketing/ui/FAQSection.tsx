'use client'

import { motion } from 'motion/react'
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion'
import { faqItems } from '../lib/faq-items'
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants'

/** FAQ accordion section — handles residual objections before the install CTA. */
export function FAQSection() {
  return (
    <section className="bg-cream-secondary px-8 py-14 md:py-24">
      <motion.div
        className="mx-auto max-w-2xl"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        {/* Eyebrow */}
        <motion.span
          variants={REVEAL}
          className="mb-6 block text-center font-mono text-2xs uppercase tracking-[0.2em] text-brand-orange"
        >
          Questions
        </motion.span>

        {/* Accordion */}
        <motion.div variants={REVEAL}>
          <Accordion>
            {faqItems.map((item) => (
              <AccordionItem
                key={item.id}
                value={item.id}
                className="border-charcoal/10"
              >
                <AccordionTrigger className="text-charcoal">
                  {item.question}
                </AccordionTrigger>
                <AccordionContent>
                  <p className="text-warm-gray leading-relaxed">
                    {item.answer}
                  </p>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </motion.div>
      </motion.div>
    </section>
  )
}
