import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { openExternalWindowLater, type PendingExternalWindow } from '@/layers/shared/lib';
import type { FirstRunAccountLink, FirstRunSlots } from '../model/first-run-slots';
import { useDorkosConnect } from '../model/use-dorkos-connect';
import { firstRunErrorMessage, useChooseFirstRunPath } from '../model/use-first-run';
import { useOnboarding } from '../model/use-onboarding';
import { useOnboardingStage } from '../model/use-onboarding-stage';
import { ConnectingStep } from './ConnectingStep';
import { LandingStep } from './LandingStep';
import { OwnAiStep } from './OwnAiStep';
import { WelcomeStep } from './WelcomeStep';

interface OnboardingFlowProps {
  /** Called when the first run ends and #team is on screen underneath. */
  onComplete: () => void;
  /**
   * What the first run borrows from other features, lent by the app shell
   * (the onboarding feature may not use a sibling feature's hooks). Without a
   * slot a screen shows what it can on its own.
   */
  slots?: FirstRunSlots;
}

/**
 * The first run (spec `one-minute-onboarding`, ADR 261010-143210): Welcome,
 * then one of three ways into #team — the DorkOS account, the person's own
 * AI, or no account yet. Each screen is one `?onboarding=` stage, so the
 * browser's Back walks them and a refresh keeps the place.
 *
 * @param onComplete - Called once #team has opened.
 * @param slots - The account link, the AI apps' connect flows and the model form.
 */
export function OnboardingFlow({ onComplete, slots }: OnboardingFlowProps) {
  const renderAccountLink = slots?.renderAccountLink;
  const body = (link: FirstRunAccountLink | null) => (
    <FirstRunStages link={link} slots={slots} onComplete={onComplete} />
  );
  return (
    <div className="bg-background h-full w-full overflow-y-auto">
      <div className="flex min-h-full w-full items-center justify-center p-4 py-10">
        {renderAccountLink ? renderAccountLink(body) : body(null)}
      </div>
    </div>
  );
}

/** The stage on screen, with the account link in hand when there is one. */
function FirstRunStages({
  link,
  slots,
  onComplete,
}: {
  link: FirstRunAccountLink | null;
  slots: FirstRunSlots | undefined;
  onComplete: () => void;
}) {
  const { stage, goToStage, goBack } = useOnboardingStage();
  const { startOnboarding } = useOnboarding();
  const choose = useChooseFirstRunPath();
  const [welcomeError, setWelcomeError] = useState<string | null>(null);
  // The browser window Continue opened in its click, waiting for the code.
  const waitingWindowRef = useRef<PendingExternalWindow | null>(null);

  // `startOnboarding` is idempotent (no-op once `startedAt` is set); the ref
  // bounds it to one call even though its identity changes across renders.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    startOnboarding();
  }, [startOnboarding]);

  // A window still waiting when Connecting goes never gets an address. Keyed on
  // the stage rather than an unmount cleanup: React's development double mount
  // would close the window the click had only just opened.
  useEffect(() => {
    if (stage === 'connecting') return;
    waitingWindowRef.current?.close();
    waitingWindowRef.current = null;
  }, [stage]);

  // A code still waiting is dropped before any other path is recorded: approved
  // late in the tab that is still open, it would put the DorkOS engine on
  // credits underneath the person's own pick. Read through a ref, because the
  // pick runs after awaits and must see the link as it is then.
  const linkRef = useRef(link);
  useEffect(() => {
    linkRef.current = link;
  });
  const dropPendingCode = useCallback(async () => {
    if (linkRef.current?.state === 'pending') await linkRef.current.cancel();
  }, []);

  const continueWithDorkos = useCallback(() => {
    setWelcomeError(null);
    // Opened now, in the click, or a browser blocks it once a request is in
    // between. A blocked window is fine: the code and the page are on screen.
    waitingWindowRef.current = link ? openExternalWindowLater() : null;
    goToStage('connecting');
  }, [goToStage, link]);

  const continueWithout = useCallback(async () => {
    setWelcomeError(null);
    try {
      await dropPendingCode();
      await choose.mutateAsync({ path: 'none' });
      goToStage('landing');
    } catch (error) {
      setWelcomeError(firstRunErrorMessage(error));
    }
  }, [choose, goToStage, dropPendingCode]);

  const toLanding = useCallback(() => goToStage('landing'), [goToStage]);
  const toOwnAi = useCallback(() => goToStage('own-ai'), [goToStage]);
  const backToWelcome = useCallback(() => goBack('welcome'), [goBack]);

  let screen: ReactNode;
  if (stage === 'connecting') {
    screen = link ? (
      <DorkosConnecting
        link={link}
        waitingWindowRef={waitingWindowRef}
        onReady={toLanding}
        onCancel={() => {
          // Only a code still waiting is dropped; a link already made stays.
          void dropPendingCode();
          backToWelcome();
        }}
        onUseOwnAi={() => {
          void dropPendingCode();
          toOwnAi();
        }}
      />
    ) : (
      <ConnectingStep
        phase={{ kind: 'failed', message: 'Signing in isn’t available here.' }}
        link={null}
        onRetry={backToWelcome}
        onCancel={backToWelcome}
        onUseOwnAi={toOwnAi}
      />
    );
  } else if (stage === 'own-ai') {
    screen = (
      <OwnAiStep
        onBack={backToWelcome}
        onSaved={toLanding}
        beforePick={dropPendingCode}
        slots={slots}
      />
    );
  } else if (stage === 'landing') {
    screen = <LandingStep onComplete={onComplete} />;
  } else {
    screen = (
      <WelcomeStep
        onContinueWithDorkos={continueWithDorkos}
        onUseOwnAi={toOwnAi}
        onContinueWithout={() => void continueWithout()}
        busy={choose.isPending && choose.variables?.path === 'none' ? 'none' : null}
        error={welcomeError}
      />
    );
  }
  return screen;
}

/** Connecting, driven: the hook runs the path and the screen shows it. */
function DorkosConnecting({
  link,
  waitingWindowRef,
  onReady,
  onCancel,
  onUseOwnAi,
}: {
  link: FirstRunAccountLink;
  waitingWindowRef: RefObject<PendingExternalWindow | null>;
  onReady: () => void;
  onCancel: () => void;
  onUseOwnAi: () => void;
}) {
  const { phase, retry } = useDorkosConnect({ link, waitingWindowRef, onReady });
  return (
    <ConnectingStep
      phase={phase}
      link={link}
      onRetry={retry}
      onCancel={onCancel}
      onUseOwnAi={onUseOwnAi}
    />
  );
}
