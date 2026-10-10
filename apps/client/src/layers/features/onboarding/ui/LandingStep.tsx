import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { appRoutes } from '@/layers/shared/lib';
import { Button, Spinner } from '@/layers/shared/ui';
import { firstRunErrorMessage, usePostOnboardingWelcome } from '../model/use-first-run';
import { useOnboarding } from '../model/use-onboarding';

interface LandingStepProps {
  /** Close the overlay: #team is on screen underneath. */
  onComplete: () => void;
}

/**
 * The hand-off into #team (spec `one-minute-onboarding` §2.4): DorkBot's
 * welcome is posted, the first run is marked finished, and Home — the #team
 * room — opens under the overlay as it fades. The chips under the welcome take
 * it from there. A failure says so and offers the one retry, because a first
 * run that ends in silence is the worst place to leave somebody.
 */
export function LandingStep({ onComplete }: LandingStepProps) {
  const welcome = usePostOnboardingWelcome();
  const { completeOnboarding } = useOnboarding();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const land = useCallback(async () => {
    setError(null);
    try {
      await welcome.mutateAsync();
    } catch (err) {
      setError(firstRunErrorMessage(err));
      return;
    }
    completeOnboarding();
    // Home IS #team; the overlay's own `?onboarding=` param goes with the move.
    void navigate({ ...appRoutes.home(), search: {} });
    onComplete();
  }, [welcome, completeOnboarding, navigate, onComplete]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void land();
  }, [land]);

  return (
    <div
      className="mx-auto flex w-full max-w-sm flex-col items-center px-4 text-center"
      data-testid="onboarding-landing"
    >
      {error ? (
        <>
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
          <Button className="mt-4" onClick={() => void land()}>
            Try again
          </Button>
        </>
      ) : (
        <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
          <Spinner size="xs" />
          Opening #team…
        </p>
      )}
    </div>
  );
}
