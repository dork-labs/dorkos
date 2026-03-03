import { useState, useEffect } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Search, Clock, Radio } from 'lucide-react';
import { DorkLogo } from '@dorkos/icons/logos';
import { Button } from '@/layers/shared/ui';

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

type GradientDirection = 'TOP' | 'LEFT' | 'BOTTOM' | 'RIGHT';

const DIRECTIONS: GradientDirection[] = ['TOP', 'LEFT', 'BOTTOM', 'RIGHT'];

// Radial gradients positioned at each edge — the "spotlight" sweeps around the border
const MOVING_MAP: Record<GradientDirection, string> = {
  TOP: 'radial-gradient(60% 80% at 50% 0%, hsl(var(--primary) / 0.5) 0%, transparent 100%)',
  LEFT: 'radial-gradient(50% 80% at 0% 50%, hsl(var(--primary) / 0.5) 0%, transparent 100%)',
  BOTTOM:
    'radial-gradient(60% 80% at 50% 100%, hsl(var(--primary) / 0.5) 0%, transparent 100%)',
  RIGHT:
    'radial-gradient(50% 80% at 100% 50%, hsl(var(--primary) / 0.5) 0%, transparent 100%)',
};

const HIGHLIGHT =
  'radial-gradient(80% 120% at 50% 50%, hsl(var(--primary) / 0.8) 0%, hsl(var(--primary) / 0.3) 50%, transparent 100%)';

/**
 * Welcome screen — Step 0 of onboarding.
 *
 * Sets context before the user enters the FTUE flow with a word-by-word
 * heading animation and a preview of what's coming.
 */
export function WelcomeStep({ onGetStarted, onSkip }: WelcomeStepProps) {
  const reducedMotion = useReducedMotion();
  const [hovered, setHovered] = useState(false);
  const [direction, setDirection] = useState<GradientDirection>('TOP');

  useEffect(() => {
    if (reducedMotion || hovered) return;
    const interval = setInterval(() => {
      setDirection((prev) => {
        const idx = DIRECTIONS.indexOf(prev);
        return DIRECTIONS[(idx + 1) % DIRECTIONS.length];
      });
    }, 1200);
    return () => clearInterval(interval);
  }, [hovered, reducedMotion]);

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
        className="mt-4 text-muted-foreground"
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
            <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
              <Icon className="size-5 text-muted-foreground" />
            </div>
            <span className="text-xs text-muted-foreground">{label}</span>
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
        <div
          className="relative"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          {/* Gradient sits behind the button, extends 1px beyond its edges */}
          <motion.div
            className="absolute -inset-px rounded-md blur-sm"
            animate={{
              background: hovered ? HIGHLIGHT : MOVING_MAP[direction],
            }}
            transition={{ ease: 'linear', duration: 0.4 }}
          />
          <Button size="lg" className="relative" onClick={onGetStarted}>
            Get Started
          </Button>
        </div>
        <button
          onClick={onSkip}
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Skip setup
        </button>
      </motion.div>
    </div>
  );
}
