import type { Context, Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import {
  CommunityWireSignUpConfirmationRequestSchema,
  CommunityWireSignUpConfirmationResponseSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityConfig } from '../config.js';
import { json, readJson } from '../http.js';
import { readCookie, signValue, verifyValue } from '../security.js';
import { AGE_CONFIRMATION_TTL_MS } from './minimum-age.js';

/** The cookie that carries a person's "I live in …" confirmation into account creation. */
export const COUNTRY_CONFIRMATION_COOKIE = 'community_country_confirmed';

/** What a sign-up without a live country confirmation is told. */
export const COUNTRY_CONFIRMATION_MESSAGE = 'Confirm where you live to create an account here.';
/** What a sign-up the trusted proxy places outside the allowed countries is told. */
export const COUNTRY_CLOSED_MESSAGE = "Sign-up isn't open in your country yet.";

/**
 * Two-letter codes that are well formed and that `Intl.DisplayNames` names, but that are not a
 * country a person lives in: the European Union and eurozone, the United Nations, the reserved
 * `UK` (the United Kingdom's code is `GB`), "Outlying Oceania", "Unknown Region", and the
 * pseudo-locale regions.
 */
const NOT_A_COUNTRY = new Set(['EU', 'EZ', 'UN', 'UK', 'QO', 'ZZ', 'XA', 'XB']);
const REGION_NAMES = new Intl.DisplayNames('en', { type: 'region', fallback: 'none' });

/** Whether `code` is an ISO 3166-1 alpha-2 code for a real country or territory. */
function isCountryCode(code: string): boolean {
  return /^[A-Z]{2}$/u.test(code) && !NOT_A_COUNTRY.has(code) && Boolean(REGION_NAMES.of(code));
}

/**
 * `COMMUNITY_ALLOWED_COUNTRIES`: comma-separated ISO 3166-1 alpha-2 codes, in capitals (`US`, or
 * `US,CA`). Unset or blank lets everyone sign up; anything that is not a list of real codes stops
 * the service from starting, as a mistyped minimum age does. Repeats are dropped.
 */
export const allowedCountriesSetting = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() !== '' ? value : undefined),
  z
    .string()
    .transform((value, ctx) => {
      const codes = value.split(',').map((code) => code.trim());
      const bad = codes.filter((code) => !isCountryCode(code));
      if (bad.length === 0) return [...new Set(codes)];
      const named = bad.map((code) => JSON.stringify(code)).join(', ');
      ctx.addIssue({ code: 'custom', message: `not a two-letter capital country code: ${named}` });
      return z.NEVER;
    })
    .optional()
);

/**
 * The header a trusted proxy names the caller's country in, lowercased, or `null`. It only means
 * something beside an allowed-countries list, so naming one without the list stops the service.
 */
export function countryHeaderSetting(
  header: string | undefined,
  allowedCountries: string[] | undefined
): string | null {
  if (!header) return null;
  if (!allowedCountries)
    throw new Error('COMMUNITY_COUNTRY_HEADER needs COMMUNITY_ALLOWED_COUNTRIES to be set');
  return header.toLowerCase();
}

type AllowedCountriesConfig = Pick<
  CommunityConfig,
  'allowedCountries' | 'countryHeader' | 'authSecret' | 'publicUrl'
>;

/** The list as the signed confirmation names it: order does not matter, membership does. */
function listKey(countries: string[]): string {
  return [...countries].sort().join('_');
}

/**
 * Whether this request carries a live confirmation that the person lives in one of the host's
 * current allowed countries. Always `true` when the host set none. The signed value names the
 * whole list, so any change to it (adding a country or dropping one) retires every earlier
 * confirmation, and its expiry is signed too, as the age confirmation's is.
 */
export function countryConfirmed(
  cookieHeader: string | null,
  config: AllowedCountriesConfig,
  now: Date
): boolean {
  if (config.allowedCountries === null) return true;
  const value = verifyValue(
    readCookie(cookieHeader, COUNTRY_CONFIRMATION_COOKIE),
    config.authSecret
  );
  const match = value?.match(/^countries-([A-Z_]+)-(\d+)$/u);
  if (!match) return false;
  return match[1] === listKey(config.allowedCountries) && Number(match[2]) > now.getTime();
}

/**
 * The country the host's trusted proxy put in `COMMUNITY_COUNTRY_HEADER`, or `null` when the host
 * named no header, the request carries none, or it says it does not know (`XX`, or anything that
 * is not two letters, such as Cloudflare's `T1` for Tor). A missing country is never a refusal:
 * the header narrows the person's own word, it does not replace it.
 */
function proxyCountry(headers: Headers | undefined, config: AllowedCountriesConfig) {
  if (!config.countryHeader) return null;
  const value = headers?.get(config.countryHeader)?.trim().toUpperCase();
  return value && /^[A-Z]{2}$/u.test(value) && value !== 'XX' ? value : null;
}

/** Whether the trusted proxy places this request outside the allowed countries. */
function proxyRefuses(headers: Headers | undefined, config: AllowedCountriesConfig): boolean {
  const stated = proxyCountry(headers, config);
  return stated !== null && !(config.allowedCountries ?? []).includes(stated);
}

/** Why a request may not create an account, with the code a provider callback redirects with. */
export interface SignUpRefusal {
  code: string;
  message: string;
}

/**
 * Why this request may not create an account because of where the person lives, or `null`. The
 * proxy's country, when the host trusts one and it names a country outside the list, refuses
 * first; otherwise the person must have confirmed they live in one of the allowed countries.
 * `null` whenever the host set no allowed countries, so an unset setting changes nothing.
 */
export function countryRefusal(
  headers: Headers | undefined,
  config: AllowedCountriesConfig,
  now: Date
): SignUpRefusal | null {
  if (config.allowedCountries === null) return null;
  if (proxyRefuses(headers, config))
    return { code: 'country_not_open', message: COUNTRY_CLOSED_MESSAGE };
  if (countryConfirmed(headers?.get('cookie') ?? null, config, now)) return null;
  return { code: 'country_confirmation_required', message: COUNTRY_CONFIRMATION_MESSAGE };
}

/** Clear this browser's country confirmation once it has made an account, as for the age. */
export function forgetCountryConfirmation(c: Context, config: AllowedCountriesConfig): void {
  if (config.allowedCountries === null) return;
  deleteCookie(c, COUNTRY_CONFIRMATION_COOKIE, {
    path: '/',
    secure: config.publicUrl.startsWith('https:'),
  });
}

/**
 * Register `POST /api/v1/country-confirmation`, which records that the person at this browser
 * confirmed "I live in <the allowed countries>" before creating an account. It mirrors
 * `POST /api/v1/age-confirmation`: the page sends it when the sign-up form is submitted or a
 * provider button is chosen, the cookie lasts the same 30 minutes, and every sign-up path meets it
 * at account creation. It never reads the trusted proxy's country: the page may send it before a
 * single sign-on that turns out to be an existing account's, which must not be refused for where
 * it is. Account creation alone refuses that (`country_not_open`). Not registered when the host
 * set no allowed countries, so the route answers 404 there.
 */
export function registerAllowedCountryRoutes(
  app: Hono,
  { config, now }: { config: AllowedCountriesConfig; now: () => Date }
): void {
  const allowedCountries = config.allowedCountries;
  if (allowedCountries === null) return;
  app.post('/api/v1/country-confirmation', async (c) => {
    await readJson(c, CommunityWireSignUpConfirmationRequestSchema);
    const expiresAt = new Date(now().getTime() + AGE_CONFIRMATION_TTL_MS);
    setCookie(
      c,
      COUNTRY_CONFIRMATION_COOKIE,
      // Cookie-safe characters only, as for the age confirmation.
      signValue(`countries-${listKey(allowedCountries)}-${expiresAt.getTime()}`, config.authSecret),
      {
        httpOnly: true,
        sameSite: 'Lax',
        secure: config.publicUrl.startsWith('https:'),
        path: '/',
        maxAge: AGE_CONFIRMATION_TTL_MS / 1000,
      }
    );
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityWireSignUpConfirmationResponseSchema, {
      confirmed: true,
      expiresAt: expiresAt.toISOString(),
    });
  });
}
