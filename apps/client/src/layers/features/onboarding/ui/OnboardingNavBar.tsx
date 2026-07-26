import { Button } from '@/layers/shared/ui';

interface OnboardingNavBarProps {
  /** Called when the user clicks Back (returns to the ready gate). */
  onBack: () => void;
  /** Called when the user leaves setup entirely (dismisses the whole flow). */
  onSkipAll: () => void;
}

/**
 * Navigation bar for the onboarding conversation — Back to the ready gate and
 * one honest whole-flow exit. A conversation is not a dotted wizard, so there
 * are no step dots.
 *
 * The exit is labelled "Skip all setup", not "Skip setup": it ends onboarding
 * rather than advancing a step, and a bare "Skip" next to "Back" read as "skip
 * this bit" (DOR-472). Skipping a single beat is offered by the beat itself —
 * "Skip this step" on the personality card, "Not now" on discovery.
 */
export function OnboardingNavBar({ onBack, onSkipAll }: OnboardingNavBarProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3 sm:px-6">
      <Button variant="ghost" size="sm" onClick={onBack}>
        Back
      </Button>
      <Button variant="ghost" size="sm" onClick={onSkipAll} className="text-muted-foreground">
        Skip all setup
      </Button>
    </div>
  );
}
