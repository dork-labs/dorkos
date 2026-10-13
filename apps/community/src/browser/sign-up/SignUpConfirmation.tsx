import { Label } from '@dork-labs/ui';
import type { CommunityWireAuthOptions } from '@dorkos/shared/community-wire';
import { hostRequest } from '../api.js';
import { countryList } from './country-names.js';

/** What the host asks a person to confirm before a new account is made here. */
export type SignUpRules = Pick<CommunityWireAuthOptions, 'minimumAge' | 'allowedCountries'>;

/**
 * The host's sign-up rules, or `null` when it set none, so a page asks nothing. A Community from
 * before allowed countries sends none, which reads as everyone.
 */
export function signUpRules(options: CommunityWireAuthOptions): SignUpRules | null {
  const allowedCountries = options.allowedCountries ?? null;
  if (options.minimumAge === null && allowedCountries === null) return null;
  return { minimumAge: options.minimumAge, allowedCountries };
}

/**
 * Tell the host this person confirmed its sign-up rules, just before an account is created. The
 * server keeps each answer in a short-lived cookie that the password sign-up, the first owner's
 * setup, and a Google, GitHub or single sign-on round trip each carry to account creation.
 */
export async function confirmSignUp(rules: SignUpRules): Promise<void> {
  if (rules.minimumAge !== null)
    await hostRequest('/api/v1/age-confirmation', 'POST', { confirmed: true });
  if (rules.allowedCountries !== null)
    await hostRequest('/api/v1/country-confirmation', 'POST', { confirmed: true });
}

/** The rule line and the box's words, for whichever rules the host set. */
function wording({ minimumAge, allowedCountries }: SignUpRules): { rule: string; box: string } {
  const countries = allowedCountries === null ? null : countryList(allowedCountries);
  if (countries === null)
    return {
      rule: `You must be at least ${minimumAge} to join.`,
      box: `I am at least ${minimumAge} years old.`,
    };
  if (minimumAge === null)
    return { rule: `Open to people who live in ${countries}.`, box: `I live in ${countries}.` };
  return {
    rule: `You must be at least ${minimumAge} and live in ${countries} to join.`,
    box: `I am at least ${minimumAge} years old and live in ${countries}.`,
  };
}

/** One rule line and its box; `required` stops a form from sending until it is ticked. */
function RuleBox({
  id,
  rule,
  box,
  confirmed,
  onChange,
  required,
}: {
  id: string;
  rule: string;
  box: string;
  confirmed: boolean;
  onChange: (confirmed: boolean) => void;
  required: boolean;
}) {
  return (
    <div className="mb-4">
      <p className="small muted mb-2" id={`${id}-rule`}>
        {rule}
      </p>
      <Label htmlFor={id} className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          className="mt-1 size-4 shrink-0"
          aria-describedby={`${id}-rule`}
          checked={confirmed}
          onChange={(event) => onChange(event.target.checked)}
          required={required}
        />
        <span>{box}</span>
      </Label>
    </div>
  );
}

/**
 * The host's sign-up rules on a form that creates an account: one plain line, and one box the
 * person must tick first. The box is `required`, so the browser stops a password sign-up that
 * skipped it; the provider buttons read `confirmed` to stay off until it is ticked.
 */
export function SignUpConfirmation({
  id,
  rules,
  confirmed,
  onChange,
}: {
  id: string;
  rules: SignUpRules;
  confirmed: boolean;
  onChange: (confirmed: boolean) => void;
}) {
  return <RuleBox id={id} {...wording(rules)} confirmed={confirmed} onChange={onChange} required />;
}

/**
 * What a single sign-on round trip confirms before it starts: the minimum age, which the page
 * already required, and the countries only when the person ticked that they are new here. `null`
 * when there is nothing to confirm.
 */
export function singleSignOnConfirmations(
  rules: SignUpRules | null,
  countryConfirmed: boolean
): SignUpRules | null {
  if (rules === null) return null;
  const allowedCountries = countryConfirmed ? rules.allowedCountries : null;
  if (rules.minimumAge === null && allowedCountries === null) return null;
  return { minimumAge: rules.minimumAge, allowedCountries };
}

/**
 * The host's sign-up rules above a single sign-on button, which cannot tell a new person from an
 * account that already exists. The minimum age is asked exactly as on a sign-up form, and the
 * button stays off until it is ticked. The countries get a box of their own that is never
 * required: someone signing in to an existing account, wherever they are, leaves it alone, and a
 * new person who skips it comes back with a note asking them to tick it.
 */
export function SingleSignOnRules({
  id,
  rules,
  ageConfirmed,
  onAgeChange,
  countryConfirmed,
  onCountryChange,
}: {
  id: string;
  rules: SignUpRules;
  ageConfirmed: boolean;
  onAgeChange: (confirmed: boolean) => void;
  countryConfirmed: boolean;
  onCountryChange: (confirmed: boolean) => void;
}) {
  const countries = rules.allowedCountries === null ? null : countryList(rules.allowedCountries);
  return (
    <>
      {rules.minimumAge !== null && (
        <SignUpConfirmation
          id={id}
          rules={{ minimumAge: rules.minimumAge, allowedCountries: null }}
          confirmed={ageConfirmed}
          onChange={onAgeChange}
        />
      )}
      {countries !== null && (
        <RuleBox
          id={`${id}-country`}
          rule={`New accounts are open to people who live in ${countries}.`}
          box={`I'm new here and live in ${countries}.`}
          confirmed={countryConfirmed}
          onChange={onCountryChange}
          required={false}
        />
      )}
    </>
  );
}
