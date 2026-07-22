import { useCallback, useEffect, useRef } from 'react';
import type { RuntimeConnectSlot } from '@/layers/entities/runtime';
import { useOnboarding } from '../model/use-onboarding';
import { useOnboardingStage } from '../model/use-onboarding-stage';
import { OnboardingNavBar } from './OnboardingNavBar';
import { SystemRequirementsStep } from './SystemRequirementsStep';
import { WelcomeStep } from './WelcomeStep';
import { OnboardingConversation } from './OnboardingConversation';

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
 * Full-screen onboarding container: a short ready gate, then DorkBot itself.
 *
 * Flow: Welcome -> Requirements (Claude Code connected) -> Conversation. The
 * conversation is the onboarding (ADR 260722-111314): DorkBot arrives, sets its
 * personality and looks around with the user, then dissolves into a real session
 * on the user's first message. There is no finish screen.
 *
 * @param onComplete - Called when onboarding finishes (dissolve or skip).
 * @param renderRuntimeConnect - App-shell slot for the terminal-free connect flow.
 */
export function OnboardingFlow({ onComplete, renderRuntimeConnect }: OnboardingFlowProps) {
  const { stage, goToStage, goBack } = useOnboardingStage();
  const { dismiss, startOnboarding } = useOnboarding();

  // Record onboarding start timestamp once on mount. `startOnboarding` is itself
  // idempotent (no-op once `startedAt` is set); the ref bounds it to one call
  // even though its identity changes across renders.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    startOnboarding();
  }, [startOnboarding]);

  const handleSkipAll = useCallback(async () => {
    await dismiss();
    onComplete();
  }, [dismiss, onComplete]);

  // All stage moves go through the history-integrated navigator so browser
  // back/forward and the in-UI Back button walk the same path. The in-UI Back
  // pops the forward push (mirroring browser-Back) rather than pushing again,
  // and falls back to requirements when the user landed here via refresh.
  const goToRequirements = useCallback(() => goToStage('requirements'), [goToStage]);
  const goToConversation = useCallback(() => goToStage('conversation'), [goToStage]);
  const backToRequirements = useCallback(() => goBack('requirements'), [goBack]);

  if (stage === 'welcome') {
    return (
      <div className="bg-background h-full w-full overflow-y-auto">
        <div className="flex min-h-full w-full items-center justify-center p-4">
          <WelcomeStep onGetStarted={goToRequirements} onSkip={handleSkipAll} />
        </div>
      </div>
    );
  }

  if (stage === 'requirements') {
    return (
      <div className="bg-background h-full w-full overflow-y-auto">
        <div className="flex min-h-full w-full items-center justify-center p-4 py-10">
          <SystemRequirementsStep
            onContinue={goToConversation}
            renderConnect={renderRuntimeConnect}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background flex h-full w-full flex-col">
      <OnboardingNavBar onBack={backToRequirements} onSkip={handleSkipAll} />
      <div className="min-h-0 flex-1">
        <OnboardingConversation onComplete={onComplete} />
      </div>
    </div>
  );
}
