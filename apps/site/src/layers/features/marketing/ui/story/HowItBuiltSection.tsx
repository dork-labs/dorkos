'use client';

import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT_REPEAT as VIEWPORT } from '../../lib/motion-variants';
import { evolutionSteps } from '../../lib/story-data';
import { usePresentationContext } from '../../lib/presentation-context';

interface HowItBuiltSectionProps {
  slideId?: string;
}

/** 4-step evolution timeline: LifeOS -> DorkOS -> Pulse -> Mesh. */
export function HowItBuiltSection({ slideId = 'timeline' }: HowItBuiltSectionProps) {
  const { isPresent, subStep } = usePresentationContext();

  // In presentation mode, reveal steps one at a time. In normal scroll, show all.
  const visibleSteps = isPresent ? evolutionSteps.slice(0, subStep + 1) : evolutionSteps;

  // The "active" step gets the orange accent treatment.
  // In presentation mode: the most recently revealed step. In normal mode: use the data color.
  const activeStepIndex = isPresent ? visibleSteps.length - 1 : null;

  return (
    <section
      className="bg-cream-primary flex min-h-screen flex-col justify-center px-8 py-16"
      data-slide={slideId}
    >
      <LayoutGroup>
        <div className="mx-auto w-full max-w-2xl">
          {/* Header */}
          <motion.div
            layout
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
              Two Months of Evenings
            </motion.div>
            <motion.h2
              variants={REVEAL}
              className="text-charcoal text-[clamp(20px,2.8vw,32px)] font-semibold tracking-tight"
            >
              Each step hit a ceiling. Each ceiling became the next build.
            </motion.h2>
          </motion.div>

          {/* Timeline steps */}
          <motion.div layout className="flex flex-col gap-6">
            <AnimatePresence initial={false}>
              {visibleSteps.map((step, i) => {
                const isActive =
                  activeStepIndex !== null ? i === activeStepIndex : step.color === 'orange';
                return (
                  <motion.div
                    key={step.step}
                    layout
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.35, ease: [0.25, 0.1, 0.25, 1] }}
                    className="flex gap-4"
                  >
                    {/* Step number */}
                    <div
                      className={`text-cream-white mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-bold transition-colors duration-300 ${isActive ? 'bg-brand-orange' : 'bg-charcoal'}`}
                    >
                      {step.step}
                    </div>

                    {/* Content */}
                    <div className="min-w-0">
                      <div
                        className={`mb-0.5 font-mono text-[9px] tracking-[0.1em] uppercase transition-colors duration-300 ${isActive ? 'text-brand-orange' : 'text-warm-gray'}`}
                      >
                        {step.product} &mdash; {step.duration}
                      </div>
                      <p className="text-charcoal mb-1 text-[14px] font-medium">
                        {step.description}
                      </p>
                      {step.ceiling && (
                        <p className="text-warm-gray-light font-mono text-[10px]">
                          Ceiling hit: {step.ceiling}
                        </p>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </motion.div>

          {/* Footer quote — only shown when all steps are visible */}
          <AnimatePresence>
            {(!isPresent || subStep === evolutionSteps.length - 1) && (
              <motion.div
                layout
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4, delay: 0.2 }}
                className="border-cream-tertiary mt-8 border-t pt-6"
              >
                <p className="text-warm-gray text-[13px] leading-relaxed italic">
                  &ldquo;Total calendar time from &lsquo;I want a to-do list&rsquo; to &lsquo;my
                  agents coordinate while I sleep&rsquo; &mdash;&mdash; about two months of
                  evenings.&rdquo;
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </LayoutGroup>
    </section>
  );
}
