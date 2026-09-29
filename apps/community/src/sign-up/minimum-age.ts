import type { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import {
  CommunityWireAgeConfirmationRequestSchema,
  CommunityWireAgeConfirmationResponseSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityConfig } from '../config.js';
import { ApiError, json, readJson } from '../http.js';
import { readCookie, signValue, verifyValue } from '../security.js';

/** The cookie that carries a person's age confirmation into the request that creates the account. */
export const AGE_CONFIRMATION_COOKIE = 'community_age_confirmed';

/**
 * How long one confirmation lasts: long enough to finish a Google, GitHub or single sign-on round
 * trip, short enough that a confirmation left in a shared browser does not speak for the next
 * person to sign up there.
 */
export const AGE_CONFIRMATION_TTL_MS = 30 * 60_000;

type MinimumAgeConfig = Pick<CommunityConfig, 'minimumAge' | 'authSecret' | 'publicUrl'>;

/**
 * Whether this request carries a live confirmation of the host's current minimum age. Always
 * `true` when the host set no minimum age, so an unset setting changes nothing.
 *
 * The signed value names the age it confirmed, so raising the setting (16 to 18, say) retires
 * every earlier confirmation, and its expiry is signed too, so a copied cookie stops working
 * even where a browser would have kept it.
 */
export function ageConfirmed(
  cookieHeader: string | null,
  config: MinimumAgeConfig,
  now: Date
): boolean {
  if (config.minimumAge === null) return true;
  const value = verifyValue(readCookie(cookieHeader, AGE_CONFIRMATION_COOKIE), config.authSecret);
  const match = value?.match(/^age-(\d+)-(\d+)$/u);
  if (!match) return false;
  return Number(match[1]) === config.minimumAge && Number(match[2]) > now.getTime();
}

/** The words every refusal uses, so a person always learns what to do next. */
export function ageConfirmationMessage(minimumAge: number): string {
  return `Confirm you are at least ${minimumAge} years old to create an account here.`;
}

/**
 * Refuse, with `403 FORBIDDEN`, a request that would create an account without a live age
 * confirmation. Does nothing when the host set no minimum age.
 */
export function requireAgeConfirmation(
  cookieHeader: string | null,
  config: MinimumAgeConfig,
  now: Date
): void {
  if (config.minimumAge === null || ageConfirmed(cookieHeader, config, now)) return;
  throw new ApiError(403, 'FORBIDDEN', ageConfirmationMessage(config.minimumAge));
}

/**
 * Clear this browser's confirmation once it has made an account, so the next person to sign up
 * in the same browser is asked again. The Better Auth paths do the same in `auth.ts`.
 */
export function forgetAgeConfirmation(c: Context, config: MinimumAgeConfig): void {
  if (config.minimumAge === null) return;
  deleteCookie(c, AGE_CONFIRMATION_COOKIE, {
    path: '/',
    secure: config.publicUrl.startsWith('https:'),
  });
}

/**
 * Register `POST /api/v1/age-confirmation`, which records that the person at this browser
 * confirmed "I am at least N years old" before creating an account. The page sends it when the
 * sign-up form is submitted or a provider button is chosen, never on the tick itself. It is the
 * one door every sign-up path goes through: a password sign-up, the first owner's setup, and the
 * start of a Google, GitHub or single sign-on round trip, whose callback reaches the
 * account-creation hook with this cookie. Not registered when the host set no minimum age, so the
 * route answers 404 there.
 */
export function registerMinimumAgeRoutes(
  app: Hono,
  { config, now }: { config: MinimumAgeConfig; now: () => Date }
): void {
  const minimumAge = config.minimumAge;
  if (minimumAge === null) return;
  app.post('/api/v1/age-confirmation', async (c) => {
    await readJson(c, CommunityWireAgeConfirmationRequestSchema);
    const expiresAt = new Date(now().getTime() + AGE_CONFIRMATION_TTL_MS);
    setCookie(
      c,
      AGE_CONFIRMATION_COOKIE,
      // Cookie-safe characters only: a `:` would be percent-encoded on the way out.
      signValue(`age-${minimumAge}-${expiresAt.getTime()}`, config.authSecret),
      {
        httpOnly: true,
        sameSite: 'Lax',
        secure: config.publicUrl.startsWith('https:'),
        path: '/',
        maxAge: AGE_CONFIRMATION_TTL_MS / 1000,
      }
    );
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityWireAgeConfirmationResponseSchema, {
      confirmed: true,
      expiresAt: expiresAt.toISOString(),
    });
  });
}
