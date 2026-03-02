import { useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Users, Clock, Radio } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { fireConfetti } from '@/layers/shared/lib';
import { useOnboarding } from '../model/use-onboarding';

export interface OnboardingCompleteProps {
  onComplete: () => void;
}

const HEADING_WORDS = ["You're", 'all', 'set!'];

/**
 * Completion screen shown after all onboarding steps.
 *
 * Shows a summary of what was configured, fires confetti, and provides
 * a CTA to start the first session.
 *
 * @param onComplete - Called when the user clicks "Start your first session"
 */
export function OnboardingComplete({ onComplete }: OnboardingCompleteProps) {
  const reducedMotion = useReducedMotion();
  const { state } = useOnboarding();
  const confettiFired = useRef(false);

  useEffect(() => {
    if (!confettiFired.current) {
      confettiFired.current = true;
      fireConfetti();
    }
  }, []);

  const discoveryDone = state.completedSteps.includes('discovery');
  const pulseDone = state.completedSteps.includes('pulse');

  const summaryItems = [
    {
      icon: Users,
      label: discoveryDone ? 'Agents discovered' : 'Agents skipped',
      done: discoveryDone,
    },
    {
      icon: Clock,
      label: pulseDone ? 'Schedules created' : 'Schedules skipped',
      done: pulseDone,
    },
    {
      icon: Radio,
      label: 'Adapters: coming soon',
      done: false,
    },
  ];

  return (
    <motion.div
      initial={reducedMotion ? false : { opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="mx-auto flex w-full max-w-md flex-col items-center gap-8 px-4 text-center"
    >
      {/* Text Generate Effect heading */}
      <div className="space-y-2">
        <h2 className="text-3xl font-semibold tracking-tight">
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
        </h2>
        <p className="text-muted-foreground">
          Your workspace is configured and ready.
        </p>
      </div>

      {/* Summary cards */}
      <motion.div
        className="w-full space-y-3"
        initial="hidden"
        animate="visible"
        variants={
          reducedMotion
            ? {}
            : { visible: { transition: { staggerChildren: 0.12, delayChildren: 0.3 } } }
        }
      >
        {summaryItems.map(({ icon: Icon, label, done }) => (
          <motion.div
            key={label}
            variants={
              reducedMotion
                ? {}
                : {
                    hidden: { opacity: 0, y: 12 },
                    visible: { opacity: 1, y: 0 },
                  }
            }
            transition={{ duration: 0.3 }}
            className="flex items-center gap-3 rounded-lg border p-4"
          >
            <Icon className={`size-5 ${done ? 'text-primary' : 'text-muted-foreground/50'}`} />
            <span className={done ? 'text-sm' : 'text-sm text-muted-foreground'}>
              {label}
            </span>
          </motion.div>
        ))}
      </motion.div>

      {/* CTA with glowing border */}
      <motion.div
        initial={reducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8, duration: 0.4 }}
      >
        <div className="relative">
          <div className="absolute -inset-px animate-[spin_4s_linear_infinite] rounded-lg bg-gradient-to-r from-primary/40 via-transparent to-primary/40 blur-sm" />
          <Button size="lg" className="relative" onClick={onComplete}>
            Start your first session
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
