import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useSettingsDeepLink } from '@/layers/shared/model';
import type { RuntimeConnectSlot } from '@/layers/entities/runtime';
import { useOnboarding } from '../model/use-onboarding';
import { useOnboardingStage } from '../model/use-onboarding-stage';
import { OnboardingNavBar } from './OnboardingNavBar';
import { SystemRequirementsStep } from './SystemRequirementsStep';
import { OnboardingPowerStep } from './OnboardingPowerStep';
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
 * @param onComplete - Called when onboarding ends: the conversation dissolves
 *   into a real session, or the user leaves setup entirely. Skipping a single
 *   step stays inside the flow and never calls this.
 * @param renderRuntimeConnect - App-shell slot for the terminal-free connect flow.
 */
export function OnboardingFlow({ onComplete, renderRuntimeConnect }: OnboardingFlowProps) {
  const { stage, goToStage, goBack } = useOnboardingStage();
  const { dismiss, startOnboarding } = useOnboarding();
  // The skip-all toast's shortcut back in. `?settings=preferences` is what
  // selects the tab holding "Replay setup" — the Settings dialog reads its
  // active tab from the URL.
  const { open: openSettingsTab } = useSettingsDeepLink();

  // Record onboarding start timestamp once on mount. `startOnboarding` is itself
  // idempotent (no-op once `startedAt` is set); the ref bounds it to one call
  // even though its identity changes across renders.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    startOnboarding();
  }, [startOnboarding]);

  // Leaving setup entirely. Skipping a single step never lands here — each beat
  // skips itself (DOR-472). The toast is the way back: `dismiss()` hides the
  // flow and the getting-started card for good, so without it a person who
  // leaves has no visible route back in. It names the control ("Replay setup")
  // for after the toast fades, and carries an action so the way back is one
  // click while it is still on screen.
  const handleSkipAll = useCallback(async () => {
    await dismiss();
    toast('Setup skipped', {
      description: 'You can start it again with "Replay setup" in Settings → Preferences.',
      action: { label: 'Replay setup', onClick: () => openSettingsTab('preferences') },
    });
    onComplete();
  }, [dismiss, onComplete, openSettingsTab]);

  // All stage moves go through the history-integrated navigator so browser
  // back/forward and the in-UI Back button walk the same path. The in-UI Back
  // pops the forward push (mirroring browser-Back) rather than pushing again,
  // and falls back to requirements when the user landed here via refresh.
  const goToRequirements = useCallback(() => goToStage('requirements'), [goToStage]);
  const goToPower = useCallback(() => goToStage('power'), [goToStage]);
  const goToConversation = useCallback(() => goToStage('conversation'), [goToStage]);
  const backToWelcome = useCallback(() => goBack('welcome'), [goBack]);
  const backToRequirements = useCallback(() => goBack('requirements'), [goBack]);
  const backToPower = useCallback(() => goBack('power'), [goBack]);

  if (stage === 'welcome') {
    return (
      <div className="bg-background h-full w-full overflow-y-auto">
        <div className="flex min-h-full w-full items-center justify-center p-4">
          <WelcomeStep onGetStarted={goToRequirements} onSkipAll={handleSkipAll} />
        </div>
      </div>
    );
  }

  // The requirements stage carries the same nav bar as the conversation, and it
  // is not conditional on the scan finding anything. Someone with no coding
  // agent installed cannot continue from here, so without a nav bar this screen
  // is a dead end with no in-app way out (DOR-481). They are free to leave: the
  // marketplace, the docs and the rest of the cockpit still work, and the
  // getting-started card offers the setup again later.
  if (stage === 'requirements') {
    return (
      <div className="bg-background flex h-full w-full flex-col">
        <OnboardingNavBar onBack={backToWelcome} onSkipAll={handleSkipAll} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex min-h-full w-full items-center justify-center p-4 pb-10">
            <SystemRequirementsStep onContinue={goToPower} renderConnect={renderRuntimeConnect} />
          </div>
        </div>
      </div>
    );
  }

  // The power stage carries the same nav bar and frame as the requirements
  // stage, so Back and the whole-flow exit stay in the same place. It hosts the
  // shared full-power door (spec `full-power-defaults` D3); answering it or
  // deciding later advances into the conversation.
  if (stage === 'power') {
    return (
      <div className="bg-background flex h-full w-full flex-col">
        <OnboardingNavBar onBack={backToRequirements} onSkipAll={handleSkipAll} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex min-h-full w-full items-center justify-center p-4 pb-10">
            <OnboardingPowerStep onAdvance={goToConversation} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background flex h-full w-full flex-col">
      <OnboardingNavBar onBack={backToPower} onSkipAll={handleSkipAll} />
      <div className="min-h-0 flex-1">
        <OnboardingConversation onComplete={onComplete} />
      </div>
    </div>
  );
}
