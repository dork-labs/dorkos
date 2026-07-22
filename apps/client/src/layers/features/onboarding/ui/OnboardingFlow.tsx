import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Search } from 'lucide-react';
import { useIsMobile } from '@/layers/shared/model';
import { OnboardingNavBar } from './OnboardingNavBar';
import { useDiscoveryScan, useDiscoveryStore } from '@/layers/entities/discovery';
import { resolveDefaultAgentDir } from '@/layers/entities/config';
import type { RuntimeConnectSlot } from '@/layers/entities/runtime';
import { useOnboarding } from '../model/use-onboarding';
import { SystemRequirementsStep } from './SystemRequirementsStep';
import { WelcomeStep } from './WelcomeStep';
import { MeetDorkBotStep } from './MeetDorkBotStep';
import { AgentDiscoveryStep } from './AgentDiscoveryStep';
import { OnboardingComplete } from './OnboardingComplete';

const STEPS = ['meet-dorkbot', 'discovery'] as const;

/** Zero-based index of the Meet DorkBot step. */
const MEET_DORKBOT_STEP = 0;
/** Zero-based index of the Import-projects (discovery) step. */
const DISCOVERY_STEP = 1;

/** Step index for the welcome screen (first thing the user sees). */
const WELCOME_STEP = -2;
/** Step index for the system requirements check (after welcome, before numbered steps). */
const REQUIREMENTS_STEP = -1;

/**
 * How long to wait for the background project scan to finish before giving up
 * and skipping the import step. The scan is prefetched while the user meets
 * DorkBot, so it has almost always resolved by the time they continue.
 */
const DISCOVERY_RESOLVE_TIMEOUT_MS = 8000;

/**
 * Whether the import step gets shown after Meet DorkBot. `pending` = the scan
 * has not resolved yet; `show` = it found projects worth importing; `skip` = it
 * found nothing, so the step is recorded skipped and never rendered.
 */
type DiscoveryDecision = 'pending' | 'show' | 'skip';

interface OnboardingFlowProps {
  onComplete: () => void;
  /**
   * Terminal-free connect-flow renderer, injected by the app shell and threaded
   * into the requirements step's connect cards. The onboarding feature may not
   * import the runtime-connect feature (sibling features), so the app root
   * (which may import any layer) supplies it as a slot.
   */
  renderRuntimeConnect?: RuntimeConnectSlot;
}

/**
 * Full-screen onboarding container managing step navigation, skip controls,
 * and animated transitions between onboarding steps.
 *
 * Flow: Welcome -> Requirements -> Meet DorkBot -> (Import projects?) -> Complete
 *
 * The import step is conditional: the project scan is kicked off in the
 * background when the user reaches Meet DorkBot, and the step is shown only if
 * that scan found candidates. A fresh machine with nothing to import skips it
 * silently instead of landing on a dead end.
 *
 * @param onComplete - Called when onboarding finishes (last step or skip all)
 */
export function OnboardingFlow({ onComplete, renderRuntimeConnect }: OnboardingFlowProps) {
  const [currentStep, setCurrentStep] = useState(WELCOME_STEP);
  const [direction, setDirection] = useState(1);
  const [showComplete, setShowComplete] = useState(false);
  const [resolvingDiscovery, setResolvingDiscovery] = useState(false);
  const [discoveryDecision, setDiscoveryDecision] = useState<DiscoveryDecision>('pending');
  const { completeStep, skipStep, dismiss, startOnboarding, completeOnboarding, config } =
    useOnboarding();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const reducedMotion = useReducedMotion();

  const { startScan } = useDiscoveryScan();
  const { candidates, existingAgents, isScanning, lastScanAt } = useDiscoveryStore();
  const hasScanResults = candidates.length > 0 || existingAgents.length > 0;
  const prefetchStartedRef = useRef(false);
  const [prefetchStarted, setPrefetchStarted] = useState(false);

  // Record onboarding start timestamp on mount
  useEffect(() => {
    startOnboarding();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prefetch the project scan the moment the user reaches Meet DorkBot, so the
  // import decision is usually ready by the time they continue. A warm store
  // (lastScanAt already set) is reused rather than rescanned.
  useEffect(() => {
    if (currentStep === MEET_DORKBOT_STEP && !prefetchStartedRef.current) {
      prefetchStartedRef.current = true;
      setPrefetchStarted(true);
      if (!lastScanAt && !isScanning) {
        startScan();
      }
    }
  }, [currentStep, lastScanAt, isScanning, startScan]);

  // Resolve the import decision once the prefetched scan settles (or was already
  // warm). `lastScanAt !== null` means a scan has completed at least once.
  useEffect(() => {
    if (!prefetchStarted || discoveryDecision !== 'pending') return;
    if (isScanning || lastScanAt === null) return;
    setDiscoveryDecision(hasScanResults ? 'show' : 'skip');
  }, [prefetchStarted, isScanning, lastScanAt, hasScanResults, discoveryDecision]);

  // Safety valve: never trap the user behind a hung scan — fall back to skip.
  useEffect(() => {
    if (!prefetchStarted) return;
    const timer = setTimeout(() => {
      setDiscoveryDecision((d) => (d === 'pending' ? 'skip' : d));
    }, DISCOVERY_RESOLVE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [prefetchStarted]);

  /** Mark onboarding finished and show the completion screen. */
  const finishOnboarding = useCallback(() => {
    completeOnboarding();
    setShowComplete(true);
  }, [completeOnboarding]);

  const advanceToDiscovery = useCallback(() => {
    setDirection(1);
    setCurrentStep(DISCOVERY_STEP);
  }, []);

  /**
   * After Meet DorkBot, branch on the import decision: show the step, skip it
   * silently, or wait on a checking screen until the scan resolves.
   */
  const routeAfterMeetDorkbot = useCallback(() => {
    if (discoveryDecision === 'show') {
      advanceToDiscovery();
    } else if (discoveryDecision === 'skip') {
      skipStep('discovery');
      finishOnboarding();
    } else {
      setResolvingDiscovery(true);
    }
  }, [discoveryDecision, advanceToDiscovery, skipStep, finishOnboarding]);

  // While showing the checking screen, route as soon as the decision resolves.
  useEffect(() => {
    if (!resolvingDiscovery || discoveryDecision === 'pending') return;
    setResolvingDiscovery(false);
    if (discoveryDecision === 'show') {
      advanceToDiscovery();
    } else {
      skipStep('discovery');
      finishOnboarding();
    }
  }, [resolvingDiscovery, discoveryDecision, advanceToDiscovery, skipStep, finishOnboarding]);

  const handleStepComplete = useCallback(() => {
    completeStep(STEPS[currentStep]);
    if (currentStep === MEET_DORKBOT_STEP) {
      routeAfterMeetDorkbot();
    } else {
      finishOnboarding();
    }
  }, [currentStep, completeStep, routeAfterMeetDorkbot, finishOnboarding]);

  const handleSkip = useCallback(() => {
    skipStep(STEPS[currentStep]);
    if (currentStep === MEET_DORKBOT_STEP) {
      routeAfterMeetDorkbot();
    } else {
      finishOnboarding();
    }
  }, [currentStep, skipStep, routeAfterMeetDorkbot, finishOnboarding]);

  const handleSkipAll = useCallback(async () => {
    await dismiss();
    onComplete();
  }, [dismiss, onComplete]);

  const goBack = useCallback(() => {
    if (currentStep > MEET_DORKBOT_STEP) {
      setDirection(-1);
      setCurrentStep((prev) => prev - 1);
    } else if (currentStep === MEET_DORKBOT_STEP) {
      setDirection(-1);
      setCurrentStep(WELCOME_STEP);
    }
  }, [currentStep]);

  const handleWelcomeStart = useCallback(() => {
    setDirection(1);
    setCurrentStep(REQUIREMENTS_STEP);
  }, []);

  const handleRequirementsContinue = useCallback(() => {
    setDirection(1);
    setCurrentStep(MEET_DORKBOT_STEP);
  }, []);

  /** Navigate to a chat session with the configured default agent. */
  const navigateToDefaultAgent = useCallback(() => {
    navigate({ to: '/session', search: { dir: resolveDefaultAgentDir(config) } });
    onComplete();
  }, [config, navigate, onComplete]);

  // Show the completion screen
  if (showComplete) {
    return (
      <div className="bg-background h-full w-full overflow-y-auto">
        <div className="flex min-h-full w-full items-center justify-center p-4">
          <OnboardingComplete onComplete={navigateToDefaultAgent} />
        </div>
      </div>
    );
  }

  // Brief checking screen while the prefetched scan settles after Meet DorkBot.
  if (resolvingDiscovery) {
    return (
      <div className="bg-background h-full w-full overflow-y-auto">
        <div className="flex min-h-full w-full flex-col items-center justify-center gap-4 p-4">
          <motion.div
            animate={reducedMotion ? {} : { scale: [1, 1.15, 1] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
          >
            <Search className="text-muted-foreground size-8" />
          </motion.div>
          <p className="text-muted-foreground text-sm">Checking your machine...</p>
        </div>
      </div>
    );
  }

  // Welcome screen (step -2) — greet the user first
  if (currentStep === WELCOME_STEP) {
    return (
      <div className="bg-background h-full w-full overflow-y-auto">
        <div className="flex min-h-full w-full items-center justify-center p-4">
          <WelcomeStep onGetStarted={handleWelcomeStart} onSkip={handleSkipAll} />
        </div>
      </div>
    );
  }

  // System requirements check (step -1) — after welcome, before numbered steps.
  // The wrapper scrolls (min-h-full + overflow-y-auto) so the connect cards and
  // "more agents" disclosure never clip on short viewports or mobile.
  if (currentStep === REQUIREMENTS_STEP) {
    return (
      <div className="bg-background h-full w-full overflow-y-auto">
        <div className="flex min-h-full w-full items-center justify-center p-4 py-10">
          <SystemRequirementsStep
            onContinue={handleRequirementsContinue}
            renderConnect={renderRuntimeConnect}
          />
        </div>
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

  // Honest step count: only advertise the import step when it will actually run.
  const totalSteps = discoveryDecision === 'skip' ? 1 : STEPS.length;

  return (
    <div className="bg-background flex h-full w-full flex-col">
      <OnboardingNavBar
        totalSteps={totalSteps}
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
              {currentStep === MEET_DORKBOT_STEP && (
                <MeetDorkBotStep onStepComplete={handleStepComplete} />
              )}
              {currentStep === DISCOVERY_STEP && (
                <AgentDiscoveryStep onStepComplete={handleStepComplete} />
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
