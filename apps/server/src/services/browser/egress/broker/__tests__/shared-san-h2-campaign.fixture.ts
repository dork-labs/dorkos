import { z } from 'zod';
import { parseDestination } from '../../destination.js';
import { readOriginalConnectDenialBank } from '../../../runtime/private-native-projection.js';
import { assertSharedSANH2Evidence } from './shared-san-h2-origin.fixture.js';

const endpoint = z
  .object({
    allowedOrigin: z.string().url(),
    deniedOrigin: z.string().url(),
  })
  .strict();
/** Required external fixture input. Parsing proves shape only, never DNS/TLS/H2 success. */
export function readSharedSANH2Endpoint(value: unknown) {
  const input = endpoint.parse(value);
  const allowed = new URL(input.allowedOrigin),
    denied = new URL(input.deniedOrigin);
  for (const url of [allowed, denied]) {
    if (
      url.protocol !== 'https:' ||
      url.port !== '' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(url.hostname) ||
      url.hostname === 'localhost' ||
      url.hostname.endsWith('.localhost') ||
      /^[0-9.]+$/u.test(url.hostname)
    )
      throw new Error('H2_ROUTABLE_TRUSTED_ENDPOINT_REQUIRED');
  }
  if (allowed.hostname === denied.hostname) throw new Error('H2_DISTINCT_AUTHORITIES_REQUIRED');
  return Object.freeze({
    allowedOrigin: allowed.origin,
    deniedOrigin: denied.origin,
    allowedAuthority: allowed.hostname + ':443',
    deniedAuthority: denied.hostname + ':443',
    warmURL: new URL('/warm', allowed).href,
    deniedURL: new URL('/forbidden', denied).href,
    continueURL: new URL('/continue', allowed).href,
  });
}

/** Consume actual controlled-upstream rows and the constructor-owned CLI observation bank. */
export function assertOriginalSharedSANH2Campaign(input: {
  endpoint: unknown;
  originalProjection: unknown;
  browserId: string;
  browserGeneration: number;
  allowedSession: number;
  rows: ReadonlyArray<{ session: number; authority: string; path: string }>;
}) {
  const endpoint = readSharedSANH2Endpoint(input.endpoint);
  const denials = readOriginalConnectDenialBank(input.originalProjection).filter(
    (row) =>
      row.browserId === input.browserId &&
      row.browserGeneration === input.browserGeneration &&
      // Transient DNS/cancellation/refused binding is not evidence of a policy-denied destination.
      (row.reason === 'ADMIN_DENIED' ||
        row.reason === 'ADDRESS_DENIED' ||
        row.reason === 'GRANT_REFUSED')
  );
  assertSharedSANH2Evidence({
    ...endpoint,
    allowedSession: input.allowedSession,
    // HTTP/2 omits the default port in :authority; compare the original canonical authority.
    rows: input.rows.map((row) => ({
      ...row,
      authority: parseDestination({ url: 'https://' + row.authority + '/' }).authority,
    })),
    originalConnectDenials: denials,
  });
  return Object.freeze({ endpoint, originalConnectDenials: Object.freeze(denials) });
}
