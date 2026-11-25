/**
 * How a path with glob characters is spelled in a Codex profile's
 * `filesystem` table, so a folder like `site [old]` is matched as written.
 *
 * Codex 0.163 reads a key holding `*`, `?`, `[` or `]` as a glob, and inside a
 * glob `{a,b}` is a choice. A glob key may only `deny`: a `read` one fails
 * the whole profile ("only supports `deny` access"), and a plain path that is
 * read as a glob loses its subtree. Checked on the vendored binary:
 * - inside a glob, `[c]` matches the character `c` itself, and a lone `]` is
 *   plain, on macOS (Seatbelt) and in the matcher Linux uses (`globset`);
 * - a scoped key `{ ".": access }` is always an exact path with its subtree,
 *   whatever the path holds (the `.` subpath has no glob characters).
 *
 * @module services/runtimes/codex/policy/codex-path-keys
 */

type Access = 'read' | 'deny';

/** One rendered `filesystem` value: an access, or the scoped exact-path spelling. */
export type CodexFilesystemValue = Access | { '.': Access };

/** Characters that make Codex read part of a key as glob syntax. */
const GLOB_CHARS = /[*?[\]{}]/;

/**
 * A literal path, spelled for the fixed part of a glob key: each `*`, `?`,
 * `[`, `{` and `}` becomes a one-character class. A lone `]` stays as it is:
 * `[]]` would be an empty class to Codex's Seatbelt translation.
 *
 * @param literal - A path in Codex's slash spelling, with no glob meant.
 */
export function codexGlobLiteral(literal: string): string {
  return literal.replace(/[*?[{}]/g, (char) => `[${char}]`);
}

/**
 * The entries with every exact path that holds a glob character moved to the
 * scoped spelling, so Codex reads it as written. Glob keys stay as they are.
 *
 * @param entries - Rendered entries, exact paths spelled as they are.
 * @param isGlob - Whether a key is a glob DorkOS built.
 */
export function codexExactKeys(
  entries: Readonly<Record<string, Access>>,
  isGlob: (key: string) => boolean = () => false
): Record<string, CodexFilesystemValue> {
  return Object.fromEntries(
    Object.entries(entries).map(([key, access]) => [
      key,
      !isGlob(key) && GLOB_CHARS.test(key) ? { '.': access } : access,
    ])
  );
}
