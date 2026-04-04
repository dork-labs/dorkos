import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useIsMobile } from '@/layers/shared/model';
import { OnboardingNavBar } from './OnboardingNavBar';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useOnboarding } from '../model/use-onboarding';
import { SystemRequirementsStep } from './SystemRequirementsStep';
import { WelcomeStep } from './WelcomeStep';
import { MeetDorkBotStep } from './MeetDorkBotStep';
import { AgentDiscoveryStep } from './AgentDiscoveryStep';
import { TaskTemplatesStep } from './TaskTemplatesStep';
import { OnboardingComplete } from './OnboardingComplete';

const STEPS = ['meet-dorkbot', 'discovery', 'tasks'] as const;

/** Index of the Tasks step within STEPS — used for auto-skip logic. */
const TASKS_STEP_INDEX = STEPS.indexOf('tasks');

/** Step index for the welcome screen (first thing the user sees). */
const WELCOME_STEP = -2;
/** Step index for the system requirements check (after welcome, before numbered steps). */
const REQUIREMENTS_STEP = -1;

interface OnboardingFlowProps {
  onComplete: () => void;
  initialStep?: number;
}

/**
 * Full-screen onboarding container managing step navigation, skip controls,
 * and animated transitions between onboarding steps.
 *
 * Flow: Welcome -> Requirements -> Meet DorkBot -> Discovery -> Tasks -> Complete
 *
 * @param onComplete - Called when onboarding finishes (last step or skip all)
 * @param initialStep - Step index to start at (default: -2 for welcome)
 */
export function OnboardingFlow({ onComplete, initialStep = WELCOME_STEP }: OnboardingFlowProps) {
  const [currentStep, setCurrentStep] = useState(initialStep);
  const [direction, setDirection] = useState(1);
  const [showComplete, setShowComplete] = useState(false);
  const { completeStep, skipStep, dismiss, startOnboarding, config } = useOnboarding();
  const navigate = useNavigate();
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
      // Mark adapters as completed since we removed that step from the visible flow
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
      setCurrentStep(WELCOME_STEP);
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
    setCurrentStep(REQUIREMENTS_STEP);
  }, []);

  const handleRequirementsContinue = useCallback(() => {
    setDirection(1);
    setCurrentStep(0);
  }, []);

  /** Navigate to a chat session with the configured default agent. */
  const navigateToDefaultAgent = useCallback(() => {
    const defaultAgent = config?.agents?.defaultAgent || 'dorkbot';
    const defaultDir = config?.agents?.defaultDirectory || '~/.dork/agents';
    const agentPath = `${defaultDir}/${defaultAgent}`;
    navigate({ to: '/session', search: { dir: agentPath } });
    onComplete();
  }, [config, navigate, onComplete]);

  // Auto-skip Tasks step when no agents are registered
  useEffect(() => {
    if (
      currentStep === TASKS_STEP_INDEX &&
      !agentPaths.isLoading &&
      agentPaths.data?.agents.length === 0
    ) {
      completeStep('tasks');
      goNext();
    }
  }, [currentStep, agentPaths.isLoading, agentPaths.data, completeStep, goNext]);

  // Show the completion screen
  if (showComplete) {
    return (
      <div className="bg-background flex h-full w-full items-center justify-center">
        <OnboardingComplete onComplete={navigateToDefaultAgent} />
      </div>
    );
  }

  // Welcome screen (step -2) — greet the user first
  if (currentStep === WELCOME_STEP) {
    return (
      <div className="bg-background flex h-full w-full items-center justify-center">
        <WelcomeStep onGetStarted={handleWelcomeStart} onSkip={handleSkipAll} />
      </div>
    );
  }

  // System requirements check (step -1) — after welcome, before numbered steps
  if (currentStep === REQUIREMENTS_STEP) {
    return (
      <div className="bg-background flex h-full w-full items-center justify-center">
        <SystemRequirementsStep onContinue={handleRequirementsContinue} />
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
    <div className="bg-background flex h-full w-full flex-col">
      <OnboardingNavBar
        totalSteps={STEPS.length}
        currentStep={currentStep}
        onBack={goBack}
        onSkip={handleSkip}
        onSkipAll={handleSkipAll}
      />

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
              {currentStep === 0 && <MeetDorkBotStep onStepComplete={handleStepComplete} />}
              {currentStep === 1 && <AgentDiscoveryStep onStepComplete={handleStepComplete} />}
              {currentStep === 2 && (
                <TaskTemplatesStep
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
