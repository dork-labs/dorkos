import type { Context, Hono } from 'hono';
import type { CommunityConfig } from '../config.js';
import { ApiError } from '../http.js';
import {
  AGE_CONFIRMATION_COOKIE,
  ageConfirmationMessage,
  ageConfirmed,
  forgetAgeConfirmation,
  registerMinimumAgeRoutes,
} from './minimum-age.js';
import {
  COUNTRY_CONFIRMATION_COOKIE,
  countryRefusal,
  forgetCountryConfirmation,
  registerAllowedCountryRoutes,
  type SignUpRefusal,
} from './allowed-countries.js';

/**
 * The host's sign-up rules, met in one place by every path that creates an account: a password
 * sign-up, the first owner's setup, an owner claim, and a Google, GitHub or single sign-on round
 * trip (including an open join), whose callback reaches the account-creation hook in `auth.ts`.
 * Each rule is off until the host sets it, and then changes nothing. Signing in to an account
 * that already exists, or an existing account joining another space, never meets them: they are
 * about who may become a new person here.
 */
type SignUpRulesConfig = Pick<
  CommunityConfig,
  'minimumAge' | 'allowedCountries' | 'countryHeader' | 'authSecret' | 'publicUrl'
>;

/**
 * Why this request may not create an account, or `null` when every rule the host set is met.
 * A trusted proxy placing the request outside the allowed countries is reported first, since no
 * tick can fix it; then a missing age confirmation; then a missing country confirmation.
 */
export function signUpRefusal(
  headers: Headers | undefined,
  config: SignUpRulesConfig,
  now: Date
): SignUpRefusal | null {
  const country = countryRefusal(headers, config, now);
  if (country?.code === 'country_not_open') return country;
  if (config.minimumAge !== null && !ageConfirmed(headers?.get('cookie') ?? null, config, now))
    return {
      code: 'age_confirmation_required',
      message: ageConfirmationMessage(config.minimumAge),
    };
  return country;
}

/** Refuse, with `403 FORBIDDEN`, a request that would create an account against a sign-up rule. */
export function requireSignUpConfirmations(
  headers: Headers | undefined,
  config: SignUpRulesConfig,
  now: Date
): void {
  const refusal = signUpRefusal(headers, config, now);
  if (refusal) throw new ApiError(403, 'FORBIDDEN', refusal.message);
}

/**
 * The confirmation cookies this host sets, so the account-creation hook can clear each one once
 * it has made an account: one tick makes one account.
 */
export function signUpConfirmationCookies(config: SignUpRulesConfig): string[] {
  return [
    ...(config.minimumAge === null ? [] : [AGE_CONFIRMATION_COOKIE]),
    ...(config.allowedCountries === null ? [] : [COUNTRY_CONFIRMATION_COOKIE]),
  ];
}

/** Clear every confirmation this browser holds once it has made an account. */
export function forgetSignUpConfirmations(c: Context, config: SignUpRulesConfig): void {
  forgetAgeConfirmation(c, config);
  forgetCountryConfirmation(c, config);
}

/** Register the confirmation route for each sign-up rule the host set, and none for the rest. */
export function registerSignUpConfirmationRoutes(
  app: Hono,
  deps: { config: SignUpRulesConfig; now: () => Date }
): void {
  registerMinimumAgeRoutes(app, deps);
  registerAllowedCountryRoutes(app, deps);
}
