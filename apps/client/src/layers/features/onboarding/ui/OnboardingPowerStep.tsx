import { useCallback } from 'react';

import { FullPowerDoor } from '@/layers/features/full-power-door';
import { Button, Dialog } from '@/layers/shared/ui';

import { useOnboarding } from '../model/use-onboarding';

/** Props for {@link OnboardingPowerStep}. */
interface OnboardingPowerStepProps {
  /**
   * Move on to the DorkBot conversation — the next stage. Called once the person
   * answers the power question (either way) or chooses to decide it later.
   */
  onAdvance: () => void;
}

/**
 * The onboarding stage that hosts the full-power consent door for new users.
 *
 * It mounts the same {@link FullPowerDoor} the moments rail shows existing users
 * (spec `full-power-defaults` D3), so the copy and the write sequence can never
 * drift between the two surfaces — the only difference is the heading ("Choose
 * your power level" here).
 *
 * ## Steps track flow progress, not consent
 *
 * The door itself writes the one authoritative "they answered" signal,
 * `ui.fullPowerDecidedAt`. This stage writes NO consent field: answering the door
 * either way records `completeStep('power')` (flow progress) and advances;
 * choosing "Decide later" records `skipStep('power')` and advances, writing
 * nothing about consent. A deferred new user is picked up by the moments rail
 * after onboarding, exactly like any other undecided user — the rail's predicate
 * requires onboarding to be over, so it can never surface mid-flow.
 *
 * ## No "Customize…" during setup
 *
 * The door omits its "Customize…" link here (no `onCustomize` is passed): that
 * link opens the Control Center, whose host is mounted only in AppShell's
 * main-app branch — the branch that is UNMOUNTED while the onboarding overlay is
 * showing (they are the two arms of one ternary). Offering it would open nothing,
 * and the store flag would fire the flyout disconnectedly once setup ends. New
 * users reach the Control Center any time afterwards from its persistent glyph;
 * "Keep asking me first" already covers "not now" during setup.
 *
 * ## The door needs a dialog context, not a modal
 *
 * {@link FullPowerDoor} renders `DialogTitle`/`DialogDescription`, which read
 * their ids from a Radix dialog context. This stage is not a modal — it is a
 * card inside the onboarding frame — so it wraps the door in a non-modal
 * {@link Dialog} root, which supplies that context without a portal, overlay,
 * focus trap or scroll lock.
 */
export function OnboardingPowerStep({ onAdvance }: OnboardingPowerStepProps) {
  const { completeStep, skipStep } = useOnboarding();

  // The door calls this after any definitive answer (unlock, keep-asking) —
  // never on a partial failure, where it stays up. Answering the power question
  // is a completed step; the consent field is the door's to write.
  const answered = useCallback(() => {
    completeStep('power');
    onAdvance();
  }, [completeStep, onAdvance]);

  // "Decide later" is a deferral, not an answer: it records the skip and moves
  // on, writing no consent field. The moments rail re-asks after onboarding.
  const decideLater = useCallback(() => {
    skipStep('power');
    onAdvance();
  }, [skipStep, onAdvance]);

  return (
    <Dialog open modal={false}>
      <div className="flex w-full max-w-lg flex-col items-center gap-3">
        <div className="bg-background grid w-full gap-4 rounded-lg border p-6 shadow-lg">
          <FullPowerDoor heading="Choose your power level" onClose={answered} />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={decideLater}
          data-testid="onboarding-power-decide-later"
        >
          Decide later
        </Button>
      </div>
    </Dialog>
  );
}
