import type { ServerResponse } from 'node:http';
import { z } from 'zod';

const resultSchema = z.strictObject({
  advertised: z.string().max(4096),
  protocol: z.literal('h2'),
  alternateProtocolUsage: z.literal('unspecifiedReason'),
  alternativeConnect: z.boolean(),
  deniedBeforeDial: z.boolean(),
  originalAuthorityRequest: z.boolean(),
});
/** A fixed h2 advertisement can name only one exact constructor-owned HTTPS route. */
export function originalOwnedAlternativeService(
  origin: string,
  origins: readonly string[]
): string {
  const selected = new URL(origin);
  if (
    selected.protocol !== 'https:' ||
    (selected.origin !== origin && selected.origin + ':443' !== origin) ||
    selected.hostname.length > 253 ||
    selected.port ||
    selected.username ||
    selected.password ||
    !origins.includes(origin)
  )
    throw new Error('CONTROLLED_ALT_SVC_OWNED_ORIGIN_REQUIRED');
  return `h2="${selected.hostname}:443"; ma=60`;
}
/** The real owned HTTP producer emits only this bounded h2 advertisement. */
export function writeOriginalOwnedAlternativeService(
  response: ServerResponse,
  origin: string,
  origins: readonly string[]
): void {
  response.setHeader('alt-svc', originalOwnedAlternativeService(origin, origins));
}
/** Pinned153 default h2 Alt-Svc is not selected; no request/dial absence is inferred from HTTP success alone. */
export function requireOriginalAlternativeServiceResult(value: unknown, advertisement: string) {
  const original = resultSchema.parse(value);
  if (
    original.advertised !== advertisement ||
    original.alternativeConnect ||
    original.deniedBeforeDial ||
    !original.originalAuthorityRequest
  )
    throw new Error('CONTROLLED_ORIGINAL_ALT_SVC_NONSELECTION_REQUIRED');
  return Object.freeze(original);
}
