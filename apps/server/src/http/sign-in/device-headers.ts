/**
 * The headers a checked sign-in hands Better Auth (DOR-4744, DOR-3647): only
 * what it records about the device, never a cookie or a credential, so the
 * new session is named by its browser in Signed-in devices.
 *
 * @module http/sign-in/device-headers
 */
import type { RequestFacts } from '../request-facts.js';

/**
 * The device's user agent, as a `Headers` Better Auth reads. A label only.
 *
 * @param headers - The sign-in request's raw headers.
 */
export function deviceHeaders(headers: RequestFacts['headers']): Headers {
  const out = new Headers();
  const userAgent = headers['user-agent'];
  if (typeof userAgent === 'string') out.set('user-agent', userAgent);
  return out;
}
