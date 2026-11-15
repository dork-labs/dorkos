/**
 * What a DorkOS server refuses to serve to another device, whichever way the
 * request arrives: through managed remote access or through the person's own
 * tunnel. Exported so every filter in front of a DorkOS server (the app's own
 * listeners and any edge that forwards to one) refuses the same list.
 *
 * @module remote-paths
 */

/** One refused path: the whole path (`exact`) or everything under it (`prefix`). */
export type RemoteRefusedPath = { readonly exact: string } | { readonly prefix: string };

/**
 * Paths a DorkOS server never serves over a remote connection: the
 * agent-to-agent gateway and its agent cards. Every entry is lower-case.
 *
 * How matching works, in order:
 *
 * 1. **Normalise.** Take the path (everything before the first `?`), decode it
 *    once, resolve `.` and `..` segments, and collapse repeated `/`. A path that
 *    cannot be normalised safely is refused outright rather than matched: one
 *    that fails to decode, or that still holds `..`, an encoded `.`, an encoded
 *    `/`, or a `\` (raw or encoded) after decoding once.
 * 2. **Lower-case.** Matching is case-insensitive.
 * 3. **Compare.** An `exact` entry refuses that path only; a `prefix` entry
 *    refuses any path that starts with it.
 *
 * A filter may be stricter than this, never looser.
 */
export const REMOTE_REFUSED_PATHS: readonly RemoteRefusedPath[] = Object.freeze([
  { exact: '/a2a' },
  { prefix: '/a2a/' },
  { prefix: '/.well-known/agent' },
]);
