/**
 * The ONE spelling of a working directory DorkOS speaks to the OpenCode
 * sidecar.
 *
 * The sidecar answers about directories inconsistently: `POST /session`
 * canonicalizes the `directory` it is given (real path) and stores THAT as the
 * session's directory, while `GET /session` filters on the LITERAL string it
 * receives. Measured against `opencode serve` 1.17.13, one project reached four
 * ways returned 126 sessions through its real path and zero through the symlink
 * form, a trailing slash, or a `..` spelling — so a session was invisible
 * through the exact path that created it (DOR-695).
 *
 * That asymmetry belongs to the sidecar, but the consequence is DorkOS's to
 * avoid: every directory-scoped call is made in the same spelling the sidecar
 * would have stored, so the string DorkOS filters on is the string the sidecar
 * wrote. On macOS this is not an exotic case — `/tmp` and `/var` are symlinks,
 * so `DORKOS_DEFAULT_CWD=/tmp/project` hits it on the first try.
 *
 * Sibling of `claude-code/sessions/project-slug.ts`'s `canonicalizeCwd`, which
 * exists for the same reason one layer over: the Claude SDK names a transcript
 * directory from the real path, so DorkOS has to compute the same name. Kept
 * separate deliberately — that one also mirrors the SDK's macOS NFC folding
 * because it must reproduce a NAME byte for byte, and this one must not invent
 * a transformation the sidecar was never measured to apply.
 *
 * @module services/runtimes/opencode/canonical-directory
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * A working directory in the form the OpenCode sidecar stores it: normalized
 * (`.`, `..`, doubled separators and a trailing separator collapsed) and then
 * resolved through symlinks.
 *
 * Three deliberate refusals:
 *
 * - **A relative path is returned untouched.** Resolving it here would need a
 *   process working directory this seam has no business guessing, and it would
 *   silence `listSessions`'s explicit rejection of relative input — which is
 *   there because a quietly-mismatched directory reads as "this project has no
 *   sessions" (DOR-674).
 * - **An unresolvable path falls back to the normalized form** rather than
 *   throwing. A directory that does not exist yet still deserves its `..` and
 *   trailing slash collapsed, and a session create must not fail because a
 *   `realpath` did.
 * - **Case is left alone.** `realpathSync` follows links without re-spelling
 *   the case it was handed, and folding case blindly would merge two genuinely
 *   different directories on Linux (the same reasoning `isWithinDirectory` in
 *   `@dorkos/shared/paths` records for itself).
 *
 * @param directory - A working directory, in whatever spelling it arrived
 * @returns The canonical spelling, or the input unchanged when it is relative
 */
export function canonicalDirectory(directory: string): string {
  if (!path.isAbsolute(directory)) return directory;
  const normalized = path.resolve(directory);
  try {
    return realpathSync(normalized);
  } catch {
    return normalized;
  }
}
