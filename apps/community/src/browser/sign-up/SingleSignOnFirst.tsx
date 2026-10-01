import { Button } from '@dork-labs/ui';
import type { ReactNode, Ref } from 'react';
import { MinimumAgeConfirmation } from './MinimumAgeConfirmation.js';

/**
 * A page's sign-in, led by the host's single sign-on where the page was opened with the single
 * sign-on hint (see `singleSignOnLead`): one "Continue with <label>" button, with the host's
 * minimum-age confirmation above it when the sign-in may make a new account, and every other
 * way to sign in (email and password, other providers) folded one step away below. While the
 * host's options are still loading it says so, so the form never flashes first. Without a lead,
 * the other ways are the page, exactly as they always were.
 */
export function SingleSignOnFirst({
  lead,
  disabled,
  onContinue,
  minimumAge = null,
  ageConfirmed = false,
  onAgeConfirmed = () => {},
  before,
  children,
  ref,
}: {
  /** The host's single sign-on and its name, `loading`, or `null` to show the other ways alone. */
  lead: { label: string } | 'loading' | null;
  disabled: boolean;
  /** Start the single sign-on. */
  onContinue: () => void;
  /** The host's minimum age, when this sign-in may make a new account and the host set one. */
  minimumAge?: number | null;
  /** Whether the person ticked the minimum-age box. */
  ageConfirmed?: boolean;
  onAgeConfirmed?: (confirmed: boolean) => void;
  /** Shown above the button, such as what the sign-in is for. */
  before?: ReactNode;
  /** Every other way to sign in: folded under "Other ways to sign in" behind a lead. */
  children: ReactNode;
  /** The button, for a page that moves focus to it. */
  ref?: Ref<HTMLButtonElement>;
}) {
  if (lead === 'loading')
    return (
      <div role="status" className="panel">
        Loading sign-in…
      </div>
    );
  if (!lead) return <>{children}</>;
  return (
    <>
      <div className="panel">
        {before}
        {minimumAge !== null && (
          <MinimumAgeConfirmation
            id="single-sign-on-minimum-age"
            minimumAge={minimumAge}
            confirmed={ageConfirmed}
            onChange={onAgeConfirmed}
          />
        )}
        <Button
          ref={ref}
          variant="default"
          className="w-full"
          type="button"
          // A new account must confirm the host's minimum age first, as on every sign-up.
          disabled={disabled || (minimumAge !== null && !ageConfirmed)}
          onClick={onContinue}
        >
          Continue with {lead.label}
        </Button>
      </div>
      <details className="mt-4">
        <summary className="small muted cursor-pointer">Other ways to sign in</summary>
        <div className="mt-3">{children}</div>
      </details>
    </>
  );
}
