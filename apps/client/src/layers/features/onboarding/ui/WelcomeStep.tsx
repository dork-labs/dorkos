import { motion, useReducedMotion } from 'motion/react';
import { Search, Clock, Radio } from 'lucide-react';
import { DorkLogo } from '@dorkos/icons/logos';
import { HoverBorderGradient } from '@/layers/shared/ui';

interface WelcomeStepProps {
  onGetStarted: () => void;
  onSkip: () => void;
}

const HEADING_WORDS = ['Welcome', 'to', 'DorkOS'];

const PREVIEW_ITEMS = [
  { icon: Search, label: 'Discover agents' },
  { icon: Clock, label: 'Schedule tasks' },
  { icon: Radio, label: 'Connect channels' },
] as const;

/**
 * Welcome screen — Step 0 of onboarding.
 *
 * Sets context before the user enters the FTUE flow with a word-by-word
 * heading animation and a preview of what's coming.
 */
export function WelcomeStep({ onGetStarted, onSkip }: WelcomeStepProps) {
  const reducedMotion = useReducedMotion();

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 text-center">
      {/* Logo */}
      <motion.div
        className="mb-6 opacity-80"
        initial={reducedMotion ? false : { opacity: 0, scale: 0.8 }}
        animate={{ opacity: 0.8, scale: 1 }}
        transition={{ duration: 0.4 }}
      >
        <DorkLogo size={150} className="dark:hidden" />
        <DorkLogo variant="white" size={150} className="hidden dark:block" />
      </motion.div>

      {/* Text Generate Effect heading */}
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
        {reducedMotion ? (
          HEADING_WORDS.join(' ')
        ) : (
          <motion.span
            initial="hidden"
            animate="visible"
            variants={{
              visible: { transition: { staggerChildren: 0.08 } },
            }}
          >
            {HEADING_WORDS.map((word, i) => (
              <motion.span
                key={i}
                className="inline-block"
                variants={{
                  hidden: { opacity: 0, filter: 'blur(4px)' },
                  visible: { opacity: 1, filter: 'blur(0px)' },
                }}
                transition={{ duration: 0.4 }}
              >
                {word}
                {i < HEADING_WORDS.length - 1 ? '\u00A0' : ''}
              </motion.span>
            ))}
          </motion.span>
        )}
      </h1>

      <motion.p
        className="text-muted-foreground mt-4"
        initial={reducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4, duration: 0.5 }}
      >
        Let&rsquo;s set up your AI agent workspace.
      </motion.p>

      {/* Preview items */}
      <motion.div
        className="mt-10 flex gap-8"
        initial={reducedMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6, duration: 0.4 }}
      >
        {PREVIEW_ITEMS.map(({ icon: Icon, label }, i) => (
          <div key={i} className="flex flex-col items-center gap-2">
            <div className="bg-muted flex size-10 items-center justify-center rounded-lg">
              <Icon className="text-muted-foreground size-5" />
            </div>
            <span className="text-muted-foreground text-xs">{label}</span>
          </div>
        ))}
      </motion.div>

      {/* CTA */}
      <motion.div
        className="mt-12 flex flex-col items-center gap-3"
        initial={reducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8, duration: 0.4 }}
      >
        <HoverBorderGradient className="px-6 py-2" duration={1.2} onClick={onGetStarted}>
          Get Started
        </HoverBorderGradient>
        <button
          onClick={onSkip}
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          Skip setup
        </button>
      </motion.div>
    </div>
  );
}
