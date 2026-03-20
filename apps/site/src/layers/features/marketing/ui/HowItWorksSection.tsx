'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useInView } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

interface Step {
  number: string;
  command: string;
  description: string;
}

const steps: Step[] = [
  {
    number: '01',
    command: 'npm install -g dorkos',
    description: 'One command. No config files. No Docker. No cloud account.',
  },
  {
    number: '02',
    command: 'dorkos --dir ~/projects',
    description: 'Server starts at localhost:4242. Add --tunnel for remote access from anywhere.',
  },
  {
    number: '03',
    command: 'Your agents are running.',
    description:
      'Tool approvals, session history, slash commands. Autonomous execution with full control.',
  },
];

/** Terminal block with optional typing animation. */
function TerminalBlock({ text, animate }: { text: string; animate: boolean }) {
  const [displayText, setDisplayText] = useState(text);
  const hasAnimated = useRef(false);

  useEffect(() => {
    if (!animate || hasAnimated.current) return;
    hasAnimated.current = true;
    setDisplayText('');
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setDisplayText(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(interval);
      }
    }, 50);
    return () => clearInterval(interval);
  }, [animate, text]);

  return (
    <div className="bg-cream-secondary text-charcoal mb-4 rounded-lg px-4 py-3 font-mono text-sm">
      <span>{displayText}</span>
      <span className="cursor-blink" aria-hidden="true" />
    </div>
  );
}

/** 3-step install/run/work section with scroll-triggered terminal animation. */
export function HowItWorksSection() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(sectionRef, { once: true, amount: 0.3 });

  return (
    <motion.section
      className="bg-cream-primary px-8 py-40"
      initial="hidden"
      whileInView="visible"
      viewport={VIEWPORT}
      variants={STAGGER}
    >
      <motion.span
        variants={REVEAL}
        className="text-2xs text-brand-orange mb-20 block text-center font-mono tracking-[0.15em] uppercase"
      >
        How It Works
      </motion.span>

      <motion.div
        ref={sectionRef}
        variants={STAGGER}
        className="mx-auto grid max-w-5xl grid-cols-1 gap-12 lg:grid-cols-3"
      >
        {steps.map((step, index) => (
          <motion.div key={step.number} variants={REVEAL} className="text-center">
            <span className="text-2xs text-brand-green mb-4 block font-mono tracking-[0.1em]">
              {step.number}
            </span>
            <TerminalBlock text={step.command} animate={isInView && index < 2} />
            <p className="text-warm-gray text-sm leading-relaxed">{step.description}</p>
          </motion.div>
        ))}
      </motion.div>
    </motion.section>
  );
}
