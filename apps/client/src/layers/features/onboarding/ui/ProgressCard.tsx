import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import { useOnboarding } from '../model/use-onboarding';
import { Check, Circle, Minus, X } from 'lucide-react';
import type { OnboardingStep } from '@dorkos/shared/config-schema';

const STEP_LABELS: Record<OnboardingStep, string> = {
  discovery: 'Discover agents',
  pulse: 'Set up Pulse schedules',
  adapters: 'Connect adapters',
};

const VISIBLE_STEPS: OnboardingStep[] = ['discovery', 'pulse'];

interface ProgressCardProps {
  /** Called when a user clicks an incomplete step to re-enter onboarding at that index. */
  onStepClick: (stepIndex: number) => void;
  /** Called when the user dismisses the progress card permanently. */
  onDismiss: () => void;
}

/** Compact sidebar card showing remaining onboarding steps with completion indicators. */
export function ProgressCard({ onStepClick, onDismiss }: ProgressCardProps) {
  const { state } = useOnboarding();
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      initial={reducedMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="border-border bg-card relative rounded-lg border p-3"
    >
      <button
        onClick={onDismiss}
        className="text-muted-foreground/50 hover:text-muted-foreground absolute right-1.5 top-1.5 rounded-md p-0.5 transition-colors duration-150"
        aria-label="Dismiss getting started"
      >
        <X className="size-3.5" />
      </button>

      <h3 className="text-xs font-medium mb-2">Getting Started</h3>

      <ul className="space-y-1">
        {VISIBLE_STEPS.map((step, index) => {
          const isCompleted = state.completedSteps.includes(step);
          const isSkipped = state.skippedSteps.includes(step);

          if (isCompleted) {
            return (
              <li key={step} className="flex items-center gap-2 py-0.5">
                <Check className="text-primary size-3.5 shrink-0" />
                <span className="text-muted-foreground text-xs">
                  {STEP_LABELS[step]}
                </span>
              </li>
            );
          }

          if (isSkipped) {
            return (
              <li key={step} className="flex items-center gap-2 py-0.5">
                <Minus className="text-muted-foreground/40 size-3.5 shrink-0" />
                <button
                  onClick={() => onStepClick(index)}
                  className={cn(
                    'text-muted-foreground/40 text-xs text-left transition-colors duration-150',
                    'hover:text-muted-foreground'
                  )}
                >
                  {STEP_LABELS[step]}
                </button>
              </li>
            );
          }

          return (
            <li key={step} className="flex items-center gap-2 py-0.5">
              <Circle className="text-muted-foreground size-3.5 shrink-0" />
              <button
                onClick={() => onStepClick(index)}
                className="text-foreground text-xs text-left transition-colors duration-150 hover:underline"
              >
                {STEP_LABELS[step]}
              </button>
            </li>
          );
        })}
      </ul>
    </motion.div>
  );
}
