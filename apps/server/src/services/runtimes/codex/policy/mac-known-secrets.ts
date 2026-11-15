/**
 * The macOS profile's fixed sign-in rules, applied on every render with no
 * scan (Security, DOR-4358).
 *
 * On macOS the deep "anywhere" globs become exact paths from a scan
 * ({@link ./expand-deep-globs}), and the home folder's scan runs in the
 * background. These known places are denied whatever that scan has found, so
 * the usual sign-ins are never waiting on it: Codex's auth file in its default
 * home, in `CODEX_HOME` and in DorkOS's credits home, and OpenCode's auth file
 * in its data folder. `~/.ssh`, the Claude account folders and the data
 * folder's secrets are already exact rules in the shared list.
 *
 * `known_hosts` may be read inside a denied `.ssh`: public host keys, so `git`
 * over SSH can check the host. The more specific `read` wins over the folder's
 * deny and never allows a write; verified on the binary at workspace and at
 * Full, with the keys beside it unreadable.
 *
 * macOS only: on Linux Codex hides a denied folder as a tmpfs and expands the
 * globs itself, so these would be mount points it may not be able to make.
 *
 * @module services/runtimes/codex/policy/mac-known-secrets
 */
import path from 'node:path';
import { resolveOpenCodeDataDir } from '../../opencode/opencode-data-dir.js';
import { resolveCodexHome } from '../codex-home.js';

type Access = 'read' | 'deny';

/** A path in Codex's profile spelling: absolute, `/`-separated. */
function slashed(file: string): string {
  return file.split(path.sep).join('/');
}

/**
 * Add the fixed sign-in denies and the readable `known_hosts`.
 *
 * @param entries - The rendered profile entries; changed in place and returned.
 * @param places - The home folder's spellings, the data folder, and the platform.
 */
export function withMacKnownSecrets(
  entries: Record<string, Access>,
  places: { homes: readonly string[]; data: string; platform: NodeJS.Platform }
): Record<string, Access> {
  if (places.platform !== 'darwin') return entries;
  const signIns = [
    ...places.homes.flatMap((home) => [
      path.join(home, '.codex', 'auth.json'),
      path.join(home, '.local', 'share', 'opencode', 'auth.json'),
    ]),
    path.join(resolveCodexHome(), 'auth.json'),
    path.join(places.data, 'runtimes', 'codex', 'credits', 'auth.json'),
    path.join(resolveOpenCodeDataDir(), 'auth.json'),
  ];
  for (const file of signIns) entries[slashed(file)] = 'deny';
  for (const home of places.homes) {
    const ssh = `${slashed(home)}/.ssh`;
    if (entries[ssh] === 'deny') entries[`${ssh}/known_hosts`] = 'read';
  }
  return entries;
}
