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
 *   whatever the path holds (the `.` subpath has no glob characters);
 * - a backslash in a glob escapes the next character, so `a\b` matches `ab`.
 *   `\\` matches it on macOS, but Linux searches from the text before the
 *   first glob character as a real folder (read in codex-rs `split_pattern_for_ripgrep`),
 *   and `a\\b` is no folder there; `[\\]` misses it on macOS. No spelling
 *   holds on both, so a glob over such a folder refuses instead.
 *
 * On Linux below Full, CI's bubblewrap run (DOR-4542) read the secret files
 * in `site [old]` through these spellings, though they hold at Full and on
 * macOS at every level. So there, a path with glob characters refuses too.
 *
 * @module services/runtimes/codex/policy/codex-path-keys
 */

import { CodexGitMetadataPolicyError } from './git-metadata.js';

type Access = 'read' | 'deny';

/** One rendered `filesystem` value: an access, or the scoped exact-path spelling. */
export type CodexFilesystemValue = Access | { '.': Access };

/** Characters that make Codex read part of a key as glob syntax. */
const GLOB_CHARS = /[*?[\]{}]/;

function refuseOnLinuxBelowFull(literal: string, linuxBelowFull: boolean): void {
  if (linuxBelowFull && GLOB_CHARS.test(literal))
    throw new CodexGitMetadataPolicyError(
      'glob-path-linux',
      new Error(`${literal} has glob characters, which Linux below Full can't match as written.`)
    );
}

/**
 * A literal path, spelled for the fixed part of a glob key: each `*`, `?`,
 * `[`, `{` and `}` becomes a one-character class. A lone `]` stays as it is:
 * `[]]` would be an empty class to Codex's Seatbelt translation.
 *
 * @param literal - A path in Codex's slash spelling, with no glob meant.
 * @param linuxBelowFull - Whether the profile is for Linux below Full.
 * @throws {CodexGitMetadataPolicyError} When the path holds a backslash, or
 *   glob characters on Linux below Full.
 */
export function codexGlobLiteral(literal: string, linuxBelowFull = false): string {
  if (literal.includes('\\'))
    throw new CodexGitMetadataPolicyError(
      'backslash-path',
      new Error(`${literal} has a backslash, which Codex reads as an escape.`)
    );
  refuseOnLinuxBelowFull(literal, linuxBelowFull);
  return literal.replace(/[*?[{}]/g, (char) => `[${char}]`);
}

/**
 * The entries with every exact path that holds a glob character moved to the
 * scoped spelling, so Codex reads it as written. Glob keys stay as they are.
 *
 * @param entries - Rendered entries, exact paths spelled as they are.
 * @param isGlob - Whether a key is a glob DorkOS built.
 * @param linuxBelowFull - Whether the profile is for Linux below Full.
 * @throws {CodexGitMetadataPolicyError} When such a path is rendered for Linux below Full.
 */
export function codexExactKeys(
  entries: Readonly<Record<string, Access>>,
  isGlob: (key: string) => boolean = () => false,
  linuxBelowFull = false
): Record<string, CodexFilesystemValue> {
  return Object.fromEntries(
    Object.entries(entries).map(([key, access]) => {
      if (isGlob(key) || !GLOB_CHARS.test(key)) return [key, access];
      refuseOnLinuxBelowFull(key, linuxBelowFull);
      return [key, { '.': access }];
    })
  );
}
