import { Button } from '@/layers/shared/ui';

interface OnboardingNavBarProps {
  /** Called when the user clicks Back (returns to the ready gate). */
  onBack: () => void;
  /** Called when the user clicks Skip setup (dismisses onboarding). */
  onSkip: () => void;
}

/**
 * Navigation bar for the onboarding conversation — Back to the ready gate and
 * Skip setup. A conversation is not a dotted wizard, so there are no step dots.
 */
export function OnboardingNavBar({ onBack, onSkip }: OnboardingNavBarProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3 sm:px-6">
      <Button variant="ghost" size="sm" onClick={onBack}>
        Back
      </Button>
      <Button variant="ghost" size="sm" onClick={onSkip} className="text-muted-foreground">
        Skip setup
      </Button>
    </div>
  );
}
