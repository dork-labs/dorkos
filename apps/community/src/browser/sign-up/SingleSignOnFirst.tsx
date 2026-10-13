import type { CommunityWireSignInMark } from '@dorkos/shared/community-wire';
import { useState, type ReactNode, type Ref } from 'react';
import {
  singleSignOnConfirmations,
  SingleSignOnRules,
  type SignUpRules,
} from './SignUpConfirmation.js';
import { ProviderButton } from './ProviderButton.js';

/**
 * A page's sign-in, led by the host's single sign-on where the page was opened with the single
 * sign-on hint (see `singleSignOnLead`): one "Continue with <label>" button, with the host's
 * sign-up rules above it when the sign-in may make a new account (the minimum age required, the
 * countries only for someone new; see `SingleSignOnRules`), and every other way to sign in
 * (email and password, other providers) folded one step away below. While the
 * host's options are still loading it says so, so the form never flashes first. Without a lead,
 * the other ways are the page, exactly as they always were.
 */
export function SingleSignOnFirst({
  lead,
  disabled,
  onContinue,
  rules = null,
  confirmed = false,
  onConfirmed = () => {},
  before,
  children,
  ref,
}: {
  /**
   * The host's single sign-on, its name and mark, `loading`, or `null` to show the other ways
   * alone.
   */
  lead: { label: string; mark: CommunityWireSignInMark | null } | 'loading' | null;
  disabled: boolean;
  /**
   * Start the single sign-on, given what to confirm first: the minimum age when the host set one,
   * and the allowed countries only when the person ticked that they are new here.
   */
  onContinue: (confirm: SignUpRules | null) => void;
  /** The host's sign-up rules, when this sign-in may make a new account and the host set any. */
  rules?: SignUpRules | null;
  /** Whether the person ticked the minimum-age box (the countries box is this page's own). */
  confirmed?: boolean;
  onConfirmed?: (confirmed: boolean) => void;
  /** Shown above the button, such as what the sign-in is for. */
  before?: ReactNode;
  /** Every other way to sign in: folded under "Other ways to sign in" behind a lead. */
  children: ReactNode;
  /** The button, for a page that moves focus to it. */
  ref?: Ref<HTMLButtonElement>;
}) {
  const [countryConfirmed, setCountryConfirmed] = useState(false);
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
        {rules !== null && (
          <SingleSignOnRules
            id="single-sign-on-sign-up"
            rules={rules}
            ageConfirmed={confirmed}
            onAgeChange={onConfirmed}
            countryConfirmed={countryConfirmed}
            onCountryChange={setCountryConfirmed}
          />
        )}
        <ProviderButton
          ref={ref}
          provider="oidc"
          label={lead.label}
          mark={lead.mark}
          // A new account must confirm the host's minimum age first, as on every sign-up. The
          // countries box is never required here: the sign-in may be to an existing account.
          disabled={disabled || (rules !== null && rules.minimumAge !== null && !confirmed)}
          onClick={() => onContinue(singleSignOnConfirmations(rules, countryConfirmed))}
        />
      </div>
      <details className="mt-4">
        <summary className="small muted cursor-pointer">Other ways to sign in</summary>
        <div className="mt-3">{children}</div>
      </details>
    </>
  );
}
