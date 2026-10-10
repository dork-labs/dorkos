import { DorkLogo } from '@dorkos/icons/logos';
import { CloudEligibilityNote } from '@/layers/features/cloud-link';
import { useSpacesEnabled } from '@/layers/entities/config';
import { Button, Spinner } from '@/layers/shared/ui';

interface WelcomeStepProps {
  /** Continue with DorkOS: the account path. Called from the click itself. */
  onContinueWithDorkos: () => void;
  /** Use my own AI: a key, a local model, or an AI app sign-in. */
  onUseOwnAi: () => void;
  /** Continue without an account: straight to #team, no AI connected yet. */
  onContinueWithout: () => void;
  /** The path being set up right now, so its control can say so. */
  busy?: 'dorkos' | 'none' | null;
  /** Why the last pick did not go through, or `null`. */
  error?: string | null;
}

/**
 * The first screen of DorkOS (spec `one-minute-onboarding` §2.1).
 *
 * One primary action, the account, with who can buy a plan said under it
 * before anybody leaves for the browser. Two quiet ways round it. Nothing on
 * this screen waits on a scan or an animation: the button works the moment it
 * is drawn, and no runtime, model or vendor is named.
 */
export function WelcomeStep({
  onContinueWithDorkos,
  onUseOwnAi,
  onContinueWithout,
  busy = null,
  error = null,
}: WelcomeStepProps) {
  const spaces = useSpacesEnabled();

  return (
    <div
      className="mx-auto flex w-full max-w-md flex-col items-center px-4 text-center"
      data-testid="onboarding-welcome"
    >
      <DorkLogo size={120} className="mb-8 opacity-90 dark:hidden" />
      <DorkLogo variant="white" size={120} className="mb-8 hidden opacity-90 dark:block" />

      <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        You, Multiplied.
      </h1>
      <p className="text-muted-foreground mt-3 text-balance">
        Build and run your business with an agent team.
      </p>

      <div className="mt-10 flex w-full max-w-xs flex-col items-center gap-3">
        <Button
          size="lg"
          className="w-full"
          onClick={onContinueWithDorkos}
          disabled={busy !== null}
          data-testid="onboarding-continue-dorkos"
        >
          {busy === 'dorkos' && <Spinner size="xs" />}
          Continue with DorkOS
        </Button>
        <CloudEligibilityNote withSpaces={spaces} className="text-balance" />
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="mt-8 flex flex-col items-center gap-1 sm:flex-row sm:gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={onUseOwnAi}
          disabled={busy !== null}
        >
          Use my own AI
        </Button>
        <span aria-hidden className="text-muted-foreground/50 hidden sm:inline">
          ·
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={onContinueWithout}
          disabled={busy !== null}
        >
          {busy === 'none' && <Spinner size="xs" />}
          Continue without an account
        </Button>
      </div>
    </div>
  );
}
