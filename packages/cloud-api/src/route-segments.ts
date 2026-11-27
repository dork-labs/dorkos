/**
 * How a route builder in `routes.ts` turns an opaque identifier into one path
 * segment, safely. Internal: the package's root export does not re-export it.
 *
 * @module route-segments
 */

/**
 * The fixed segments that sit where a community identifier would.
 *
 * `/v1/communities/moves`, `/v1/communities/name-check` and
 * `/v1/communities/sign-in` share a prefix with `/v1/communities/{communityId}/…`, so a community identifier equal to one of
 * them would build a path a router could read as the other route. The service
 * issues opaque identifiers that are never these words, so one arriving here is
 * a caller bug, refused like a dot segment.
 */
const COMMUNITY_FIXED_SEGMENTS: ReadonlySet<string> = new Set(['moves', 'name-check', 'sign-in']);

/**
 * Encodes a community identifier, refusing one that names a fixed route.
 *
 * @param communityId - The community's permanent identifier.
 * @throws TypeError - When the identifier is a fixed segment, empty, or a dot segment.
 */
export function communityEnc(communityId: string): string {
  if (COMMUNITY_FIXED_SEGMENTS.has(communityId)) {
    throw new TypeError(
      `A community identifier must not be ${JSON.stringify(communityId)}; it names another route.`
    );
  }
  return enc(communityId);
}

/**
 * Encodes one opaque identifier for use as a single path segment.
 *
 * Percent-encoding alone does **not** make an identifier safe here, and the
 * reason is worth writing down because it is easy to assume otherwise:
 * `encodeURIComponent('..')` is `'..'`, because a dot is an unreserved
 * character. The dot segment survives encoding intact, and `new URL()` then
 * resolves it — so the seat-release builder given `'..'` would build
 * `/v1/seats/../release` and be requested as `/v1/release`, and two dot
 * segments escape `/v1` altogether. An identifier that can move the request to another route is a
 * confused-deputy bug, and several of these identifiers (an add-on kind, a
 * toolkit slug) come from values a caller supplies.
 *
 * So a dot segment is refused rather than encoded. Refusing is right for an
 * identifier the server issued: `.` and `..` are not identifiers this service
 * hands out, so a caller holding one is already in a state no encoding would
 * make correct, and failing loudly at the call site beats silently requesting
 * a different route.
 *
 * @param segment - The opaque identifier to place in one path segment.
 * @throws TypeError - When the identifier is empty or is a dot segment.
 */
export function enc(segment: string): string {
  if (segment === '') {
    throw new TypeError('A route identifier must not be empty.');
  }
  if (segment === '.' || segment === '..') {
    throw new TypeError(
      `A route identifier must not be a dot segment (received ${JSON.stringify(segment)}); it would change which route is called.`
    );
  }
  return encodeURIComponent(segment);
}
