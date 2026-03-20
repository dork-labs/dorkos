import { useState, useCallback, useEffect } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useIsMobile } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
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
  const agentPaths = useMeshAgentPaths();

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

  const handleSkipAll = useCallback(async () => {
    await dismiss();
    onComplete();
  }, [dismiss, onComplete]);

  const handleWelcomeStart = useCallback(() => {
    setDirection(1);
    setCurrentStep(0);
  }, []);

  // Auto-skip Pulse step when no agents are registered
  useEffect(() => {
    if (currentStep === 1 && !agentPaths.isLoading && agentPaths.data?.agents.length === 0) {
      completeStep('pulse');
      goNext();
    }
  }, [currentStep, agentPaths.isLoading, agentPaths.data, completeStep, goNext]);

  // Show the completion screen
  if (showComplete) {
    return (
      <div className="bg-background fixed inset-0 z-50 flex items-center justify-center">
        <OnboardingComplete onComplete={onComplete} />
      </div>
    );
  }

  // Welcome screen (step -1)
  if (currentStep === -1) {
    return (
      <div className="bg-background fixed inset-0 z-50 flex items-center justify-center">
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
    <div className="bg-background fixed inset-0 z-50 flex flex-col">
      {/* Unified navigation bar — Back, step dots, Skip/Skip all */}
      <div className="flex items-center justify-between px-4 py-3 sm:px-6">
        <Button variant="ghost" size="sm" onClick={goBack} className="min-w-16">
          Back
        </Button>

        <div className="flex items-center gap-2">
          {STEPS.map((_, i) => (
            <div key={i} className="relative flex items-center justify-center">
              {i === currentStep ? (
                <motion.div
                  layoutId="step-indicator"
                  className="bg-primary flex h-2 w-6 items-center justify-center rounded-full"
                  transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                />
              ) : i < currentStep ? (
                <div className="bg-primary/60 flex size-2 items-center justify-center rounded-full">
                  <Check className="text-primary-foreground size-1.5" />
                </div>
              ) : (
                <div className={cn('ring-muted-foreground/30 size-2 rounded-full ring-1')} />
              )}
            </div>
          ))}
        </div>

        <div className="flex min-w-16 items-center justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={handleSkip}>
            Skip
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSkipAll}
            className="text-muted-foreground"
          >
            Skip all
          </Button>
        </div>
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
            className="absolute inset-0 flex flex-col"
          >
            <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col px-4 py-4 sm:px-6">
              {currentStep === 0 && <AgentDiscoveryStep onStepComplete={handleStepComplete} />}
              {currentStep === 1 && (
                <PulsePresetsStep
                  onStepComplete={handleStepComplete}
                  agents={agentPaths.data?.agents ?? []}
                />
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
