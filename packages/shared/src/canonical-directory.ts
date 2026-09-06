/**
 * The ONE spelling of a working directory, for the places that have to compare
 * one against another.
 *
 * Two seams need it, which is why it lives in `lib/` rather than beside either.
 *
 * **The OpenCode sidecar** answers about directories inconsistently: `POST
 * /session` canonicalizes the `directory` it is given (real path) and stores
 * THAT as the session's directory, while `GET /session` filters on the LITERAL
 * string it receives. Measured against `opencode serve` 1.17.13, one project
 * reached four ways returned 126 sessions through its real path and zero
 * through the symlink form, a trailing slash, or a `..` spelling — so a session
 * was invisible through the exact path that created it (DOR-695).
 *
 * **The per-agent fan-out** then compares a session's `cwd` — which every
 * runtime with a real store reports as the real path it ran in — against an
 * agent's configured project directory, which is whatever string was
 * registered. Making the sidecar visible again is worth nothing if the row it
 * returns is dropped one layer up for spelling the same folder differently.
 *
 * On macOS neither is exotic: `/tmp` and `/var` are symlinks, and
 * `DORKOS_DEFAULT_CWD` is taken verbatim, so `DORKOS_DEFAULT_CWD=/tmp/project`
 * hits both on the first try.
 *
 * Two deliberate non-users:
 *
 * - `lib/boundary.ts` also resolves real paths, but it decides what a caller is
 *   ALLOWED to touch and confines an unresolvable path through its deepest
 *   existing ancestor (DOR-1185). This one authorizes nothing; it only makes
 *   two strings comparable, and falls back lexically.
 * - `claude-code/sessions/project-slug.ts`'s `canonicalizeCwd` exists for a
 *   third reason — it must reproduce the name the Claude SDK writes, byte for
 *   byte, macOS NFC folding included. Merging the two would make this one
 *   invent a transformation neither seam was measured to apply.
 *
 * **Server-side only.** It touches the filesystem, so it is not importable from
 * the client — which is exactly why {@link isWithinDirectory} in `./paths`
 * stays dependency-free and says so, and why the two live side by side rather
 * than merged: `paths` is the rule, this is the reconciliation the rule cannot
 * perform for itself. Reached only through the `./canonical-directory` export
 * subpath, like the other filesystem-touching modules in this package
 * (`atomic-write`, `instance-lock`, `process-liveness`).
 *
 * @module canonical-directory
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * A working directory in the form a program that resolved it would have stored
 * it: normalized (`.`, `..`, doubled separators and a trailing separator
 * collapsed) and then resolved through symlinks.
 *
 * Synchronous, and called on paths that come up more than once (an agent root,
 * a project directory), so callers hoist it out of per-row loops rather than
 * paying a `realpath` syscall per session on the 2s-budgeted listing path.
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
