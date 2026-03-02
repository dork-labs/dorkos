import { useState, useCallback, useEffect } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useIsMobile } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { useOnboarding } from '../model/use-onboarding';
import { WelcomeStep } from './WelcomeStep';
import { AgentDiscoveryStep } from './AgentDiscoveryStep';
import { PulsePresetsStep } from './PulsePresetsStep';
import { OnboardingComplete } from './OnboardingComplete';

const STEPS = ['discovery', 'pulse'] as const;

interface OnboardingFlowProps {
  onComplete: () => void;
  initialStep?: number;
}

/**
 * Full-screen onboarding container managing step navigation, skip controls,
 * and animated transitions between onboarding steps.
 *
 * Flow: Welcome -> Discovery -> Pulse -> Complete
 *
 * @param onComplete - Called when onboarding finishes (last step or skip all)
 * @param initialStep - Zero-based index of the starting step (default: -1 for welcome)
 */
export function OnboardingFlow({ onComplete, initialStep = -1 }: OnboardingFlowProps) {
  const [currentStep, setCurrentStep] = useState(initialStep);
  const [direction, setDirection] = useState(1);
  const [showComplete, setShowComplete] = useState(false);
  const { completeStep, skipStep, dismiss, startOnboarding } = useOnboarding();
  const isMobile = useIsMobile();
  const reducedMotion = useReducedMotion();

  // Record onboarding start timestamp on mount
  useEffect(() => {
    startOnboarding();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goNext = useCallback(() => {
    if (currentStep < STEPS.length - 1) {
      setDirection(1);
      setCurrentStep((prev) => prev + 1);
    } else {
      // Also mark adapters as skipped since we removed that step
      completeStep('adapters');
      setShowComplete(true);
    }
  }, [currentStep, completeStep]);

  const goBack = useCallback(() => {
    if (currentStep > 0) {
      setDirection(-1);
      setCurrentStep((prev) => prev - 1);
    } else if (currentStep === 0) {
      // Go back to welcome
      setDirection(-1);
      setCurrentStep(-1);
    }
  }, [currentStep]);

  const handleStepComplete = useCallback(() => {
    completeStep(STEPS[currentStep]);
    goNext();
  }, [currentStep, completeStep, goNext]);

  const handleSkip = useCallback(() => {
    skipStep(STEPS[currentStep]);
    goNext();
  }, [currentStep, skipStep, goNext]);

  const handleSkipAll = useCallback(() => {
    dismiss();
    onComplete();
  }, [dismiss, onComplete]);

  const handleWelcomeStart = useCallback(() => {
    setDirection(1);
    setCurrentStep(0);
  }, []);

  // Show the completion screen
  if (showComplete) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
        <OnboardingComplete onComplete={onComplete} />
      </div>
    );
  }

  // Welcome screen (step -1)
  if (currentStep === -1) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
        <WelcomeStep onGetStarted={handleWelcomeStart} onSkip={handleSkipAll} />
      </div>
    );
  }

  const slideDistance = isMobile ? 150 : 300;
  const variants = reducedMotion
    ? {
        enter: { opacity: 0 },
        center: { opacity: 1 },
        exit: { opacity: 0 },
      }
    : {
        enter: (dir: number) => ({
          x: dir > 0 ? slideDistance : -slideDistance,
          opacity: 0,
          scale: 0.98,
          filter: 'blur(2px)',
        }),
        center: { x: 0, opacity: 1, scale: 1, filter: 'blur(0px)' },
        exit: (dir: number) => ({
          x: dir > 0 ? -slideDistance : slideDistance,
          opacity: 0,
          scale: 0.98,
          filter: 'blur(2px)',
        }),
      };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Header with skip all */}
      <div className="flex items-center justify-between px-4 py-4 sm:px-6">
        <div className="text-sm text-muted-foreground">
          Step {currentStep + 1} of {STEPS.length}
        </div>
        <Button variant="ghost" size="sm" onClick={handleSkipAll}>
          Skip all
        </Button>
      </div>

      {/* Animated step indicator */}
      <div className="flex justify-center gap-2 pb-4 sm:pb-8">
        {STEPS.map((_, i) => (
          <div key={i} className="relative flex items-center justify-center">
            {i === currentStep ? (
              <motion.div
                layoutId="step-indicator"
                className="flex h-2 w-6 items-center justify-center rounded-full bg-primary"
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              />
            ) : i < currentStep ? (
              <div className="flex size-2 items-center justify-center rounded-full bg-primary/60">
                <Check className="size-1.5 text-primary-foreground" />
              </div>
            ) : (
              <div className={cn('size-2 rounded-full ring-1 ring-muted-foreground/30')} />
            )}
          </div>
        ))}
      </div>

      {/* Step content with slide transitions */}
      <div className="relative flex-1 overflow-hidden">
        <AnimatePresence mode="wait" custom={direction}>
          <motion.div
            key={currentStep}
            custom={direction}
            variants={variants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{
              type: reducedMotion ? 'tween' : 'spring',
              damping: 25,
              stiffness: 200,
              duration: reducedMotion ? 0.15 : undefined,
            }}
            className="absolute inset-0 overflow-y-auto"
          >
            <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
              {currentStep === 0 && (
                <AgentDiscoveryStep onStepComplete={handleStepComplete} />
              )}
              {currentStep === 1 && (
                <PulsePresetsStep onStepComplete={handleStepComplete} />
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Navigation controls */}
      <div className="flex items-center justify-between border-t px-4 py-4 sm:px-6">
        <Button variant="ghost" onClick={goBack}>
          Back
        </Button>
        <Button variant="outline" onClick={handleSkip}>
          Skip
        </Button>
      </div>
    </div>
  );
}
