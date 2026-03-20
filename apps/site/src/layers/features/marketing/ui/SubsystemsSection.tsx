'use client';

import { motion } from 'motion/react';
import { SUBSYSTEMS } from '@dorkos/icons/subsystems';
import { BRAND_COLORS } from '@dorkos/icons/brand';
import { subsystems } from '../lib/subsystems';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

/** Compact subsystems reference — benefit pill above, module details below. */
export function SubsystemsSection() {
  return (
    <section className="bg-cream-primary px-8 py-20">
      <motion.div
        className="mx-auto max-w-[540px]"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        <motion.span
          variants={REVEAL}
          className="text-2xs text-brand-orange mb-6 block text-center font-mono tracking-[0.2em] uppercase"
        >
          Subsystems
        </motion.span>

        <motion.p
          variants={REVEAL}
          className="text-charcoal mb-12 text-center text-[24px] leading-[1.3] font-medium tracking-[-0.02em] md:text-[28px]"
        >
          The anatomy of your agent team.
        </motion.p>

        <motion.div variants={STAGGER} className="space-y-0">
          {subsystems.map((sub) => {
            const def = SUBSYSTEMS.find((s) => s.id === sub.id);
            const Icon = def?.icon;
            return (
              <motion.div
                key={sub.id}
                variants={REVEAL}
                className="py-4"
                style={{ borderBottom: '1px solid rgba(139, 90, 43, 0.08)' }}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center">
                    {Icon && <Icon size={20} color={BRAND_COLORS.orange} strokeWidth={1.5} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-brand-orange font-mono text-sm">{sub.name}</span>
                    <span className="text-charcoal text-sm"> &mdash; {sub.benefit}</span>
                    {sub.status === 'coming-soon' && (
                      <span className="text-2xs text-warm-gray-light ml-2 font-mono">
                        In development
                      </span>
                    )}
                    <p className="text-warm-gray mt-1 text-sm">{sub.description}</p>
                    {sub.integrations && sub.integrations.length > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {sub.integrations.map((int) => {
                          const IntIcon = int.icon;
                          const isComingSoon = int.status === 'coming-soon';
                          return (
                            <span
                              key={int.label}
                              className="inline-flex items-center gap-1 rounded-[3px] px-2 py-0.5 font-mono text-[9px] tracking-[0.08em] uppercase"
                              style={{
                                background: isComingSoon
                                  ? 'rgba(139, 90, 43, 0.04)'
                                  : 'rgba(232, 93, 4, 0.06)',
                                color: isComingSoon ? '#A69E93' : '#7A756A',
                                border: `1px solid ${isComingSoon ? 'rgba(139, 90, 43, 0.08)' : 'rgba(232, 93, 4, 0.12)'}`,
                              }}
                            >
                              <IntIcon size={10} strokeWidth={1.5} />
                              {int.label}
                              {int.qualifier && (
                                <span className="opacity-60">&middot; {int.qualifier}</span>
                              )}
                              {isComingSoon && (
                                <span className="ml-0.5 text-[8px] opacity-60">soon</span>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </motion.div>
      </motion.div>
    </section>
  );
}
