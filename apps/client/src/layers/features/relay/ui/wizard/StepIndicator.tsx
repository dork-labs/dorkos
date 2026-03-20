import { Fragment } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

type WizardStep = 'configure' | 'test' | 'confirm' | 'bind';

const STEPS: WizardStep[] = ['configure', 'test', 'confirm', 'bind'];
const STEP_LABELS: Record<WizardStep, string> = {
  configure: 'Configure',
  test: 'Test',
  confirm: 'Confirm',
  bind: 'Bind',
};

/** Visual stepper showing completed, active, and pending wizard steps. */
export function StepIndicator({
  current,
  showBindStep,
}: {
  current: WizardStep;
  showBindStep: boolean;
}) {
  const visibleSteps = showBindStep ? STEPS : STEPS.filter((s) => s !== 'bind');
  const currentIndex = visibleSteps.indexOf(current);

  return (
    <div
      className="flex items-start justify-between px-1"
      role="navigation"
      aria-label="Wizard steps"
    >
      {visibleSteps.map((s, i) => {
        const isComplete = i < currentIndex;
        const isActive = i === currentIndex;
        const isPending = i > currentIndex;

        return (
          <Fragment key={s}>
            {/* Connector line before each step except the first */}
            {i > 0 && (
              <div
                className={cn(
                  'mt-3 h-px flex-1',
                  isComplete || isActive
                    ? 'bg-primary'
                    : 'border-muted-foreground/40 border-t border-dashed'
                )}
              />
            )}

            {/* Step circle + label */}
            <div className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  'flex size-6 items-center justify-center rounded-full text-xs font-medium',
                  isComplete && 'bg-primary text-primary-foreground',
                  isActive && 'bg-primary text-primary-foreground ring-primary/30 ring-2',
                  isPending && 'border-muted-foreground text-muted-foreground border'
                )}
                aria-current={isActive ? 'step' : undefined}
              >
                {isComplete ? <Check className="size-3" /> : i + 1}
              </div>
              <span
                className={cn(
                  'text-[10px]',
                  isActive ? 'text-foreground font-medium' : 'text-muted-foreground'
                )}
              >
                {STEP_LABELS[s]}
              </span>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
