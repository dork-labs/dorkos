/**
 * Resolves where the OpenCode CLI keeps its own data — the directory holding
 * `opencode.db`, the SQLite store the sidecar writes every session, message and
 * part into.
 *
 * DorkOS neither creates nor manages this directory: OpenCode does, and this
 * module's whole job is to answer *where it is* the same way OpenCode itself
 * answers it. Verified against the provisioned `opencode` binary
 * (`opencode-ai@1.18.15`), whose global data path is
 * `$XDG_DATA_HOME || ~/.local/share` joined with `opencode`, on every platform —
 * macOS included, where it deliberately does NOT use
 * `~/Library/Application Support`.
 *
 * **Why this file may call `os.homedir()`.** That call is banned across
 * `apps/server/src` (Hard Rule 3, `.claude/rules/dork-home.md`) because
 * `~/.dork` is DorkOS's data directory and `DORK_HOME` moves it. This is not
 * `~/.dork`: it is somebody else's application's directory, whose location is
 * decided by that application, and a resolver that guessed differently from
 * OpenCode would read a store that does not exist while OpenCode writes the one
 * that does — exactly the split-brain `claude-config-dir.ts` was carved out to
 * prevent (DOR-250). This file is the fourth carve-out and, like
 * `claude-config-dir.ts`, it is exempt from the CALL ban **by filename**, so a
 * sibling module may not call `os.homedir()` either. The IMPORT ban still
 * reaches this file, so the import must stay spelled `import os from 'os'`;
 * `import { homedir }` here is a lint error.
 *
 * **The store is read, never written** — and only through a throwaway snapshot
 * copy (ADR 260825-110420). Nothing here opens anything; it returns a path.
 *
 * @module services/runtimes/opencode/opencode-data-dir
 */
import path from 'path';
import os from 'os';

/**
 * The directory OpenCode keeps its global data in.
 *
 * `$XDG_DATA_HOME/opencode` when that variable is set to something, else
 * `~/.local/share/opencode`. An empty string is treated as unset, matching the
 * `||` OpenCode's own resolver uses rather than a `!== undefined` check that
 * would resolve `/opencode` at the filesystem root.
 *
 * @returns An absolute path. It may not exist — OpenCode may never have run.
 */
export function resolveOpenCodeDataDir(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME;
  const base =
    xdgDataHome !== undefined && xdgDataHome !== ''
      ? xdgDataHome
      : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'opencode');
}

/**
 * The SQLite store OpenCode writes its sessions into, or `null` when there is no
 * file to read.
 *
 * `$OPENCODE_DB` overrides the filename, exactly as OpenCode's own resolver
 * does: an absolute path is taken as-is, a bare name is resolved inside
 * {@link resolveOpenCodeDataDir}. The one value that has no file behind it is
 * `:memory:`, and it answers `null` rather than a path nothing will ever be at —
 * a caller that has to distinguish "the store is elsewhere" from "there is no
 * store" cannot do it from a string.
 *
 * **The non-default channel case is deliberately not modelled.** OpenCode names
 * the file `opencode-<channel>.db` when it runs on a channel other than
 * `latest`/`beta`/`prod`; DorkOS provisions a pinned release and never sets a
 * channel, so guessing at one here would invent a path DorkOS's own sidecar
 * never uses. An operator running a channel build outside DorkOS points
 * `$OPENCODE_DB` at it, which is the lever OpenCode itself provides.
 *
 * @returns An absolute path to the store file, or `null` when OpenCode is
 *   configured to keep no file at all. The path is not checked for existence.
 */
export function resolveOpenCodeStorePath(): string | null {
  const override = process.env.OPENCODE_DB;
  if (override !== undefined && override !== '') {
    if (override === ':memory:') return null;
    return path.isAbsolute(override) ? override : path.join(resolveOpenCodeDataDir(), override);
  }
  return path.join(resolveOpenCodeDataDir(), 'opencode.db');
}
