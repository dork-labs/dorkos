/**
 * A `User-Agent` in a few words ("Safari on iPhone"), for the places that show
 * a person which browser something came from: the browser a hub request names
 * (`services/core/hub-relay/browser-device.ts`) and the signed-in devices list
 * (`services/core/auth/sessions/signed-in-devices.ts`).
 *
 * Only ever a label: a browser can say anything there, so nothing trusts it.
 *
 * @module lib/http/user-agent
 */

/** Platforms, most specific first: an iPad says "Macintosh" on its own. */
const PLATFORMS: ReadonlyArray<[RegExp, string]> = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/CrOS/, 'Chromebook'],
  [/Windows/, 'Windows'],
  [/Macintosh|Mac OS X/, 'Mac'],
  [/Linux/, 'Linux'],
];

/** Browsers, most specific first: Edge and Opera also say "Chrome", Chrome says "Safari". */
const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

/**
 * The platform a `User-Agent` names ("iPhone", "Mac"), or `undefined` when it
 * names none known.
 *
 * @param userAgent - The `User-Agent` header or stored value.
 */
export function userAgentPlatform(userAgent: string | undefined): string | undefined {
  const ua = userAgent ?? '';
  return PLATFORMS.find(([pattern]) => pattern.test(ua))?.[1];
}

/**
 * A short name for the browser a `User-Agent` describes, e.g. `Safari on
 * iPhone`, or `A web browser` when it says nothing recognisable.
 *
 * @param userAgent - The `User-Agent` header or stored value.
 */
export function describeUserAgent(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1];
  const platform = userAgentPlatform(ua);
  if (browser && platform) return `${browser} on ${platform}`;
  if (browser) return browser;
  if (platform) return `A browser on ${platform}`;
  return 'A web browser';
}
