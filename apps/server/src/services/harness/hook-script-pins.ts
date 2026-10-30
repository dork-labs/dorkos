/**
 * The script files a package's project hooks run, each with the sha256 of its
 * bytes, so a yes to those hooks covers exactly the files a person was shown
 * (DOR-3403).
 *
 * A hook's command is the part a settings file holds. The code it runs is
 * usually a file beside it: `node "<project>/.dork/plugins/acme/hooks/loop.mjs"`.
 * Before this, a package could rewrite `loop.mjs` after the yes and the new
 * code ran with no card, because the stored decision digested the command text
 * only (`hook-consent.ts`).
 *
 * Which paths count is the same rule the agent folder settings pin uses
 * (`namedTargets` in `folder-config-scripts.ts`), with the project as the home:
 * a relative path or `$CLAUDE_PROJECT_DIR` inside the project, or an absolute
 * path inside the project, DorkOS's `plugins/` folder, or any `.dork/plugins/`.
 *
 * Not covered (the residual, stated): a file the script imports or sources, a
 * program found on `PATH`, a path named through a variable, and a package whose
 * install folder is a dev link (a symlink to the developer's own folder, which
 * they edit all the time and which DorkOS keys by path elsewhere too).
 *
 * @module services/harness/hook-script-pins
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { namedTargets } from '../runtimes/claude-code/folder-settings/folder-config-scripts.js';

/**
 * The largest file whose bytes are hashed. A bigger one is pinned by its size
 * and change time instead: still a change when it is rewritten, without
 * reading megabytes on every projection.
 */
const MAX_HASHED_BYTES = 8 * 1024 * 1024;

/** A word with a URL scheme (`https://…`, `file://…`), which names no local script. */
const URL_WORD = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"']*/g;

/** One pinned file: its path (relative inside the project) and what it held. */
export type HookScriptPin = readonly [path: string, hash: string];

/** Whether `target` is strictly inside `base`. */
function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * What one named file holds, as a short stable string.
 *
 * `absent` for a file that is not there (so creating it later is a change),
 * `dir` for a folder, `unreadable` for anything else that cannot be read. A
 * symlinked script is followed, so the pin is on the code that actually runs.
 */
function fileFingerprint(abs: string): string {
  let stat;
  try {
    stat = statSync(abs);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
  }
  if (stat.isDirectory()) return 'dir';
  if (!stat.isFile()) return 'unreadable';
  if (stat.size > MAX_HASHED_BYTES) return `large:${stat.size}:${stat.mtimeMs}`;
  try {
    return createHash('sha256').update(readFileSync(abs)).digest('hex');
  } catch {
    return 'unreadable';
  }
}

/**
 * The files `commands` run, each with what it holds, sorted by path.
 *
 * @param projectPath - The project the hooks are projected into.
 * @param commands - The hook commands, with `${CLAUDE_PLUGIN_ROOT}` already rewritten.
 * @param dorkHome - DorkOS's data folder, whose `plugins/` global installs run from.
 * @returns One pin per named file; empty when the commands name none.
 */
export function hookScriptPins(
  projectPath: string,
  commands: readonly string[],
  dorkHome: string
): HookScriptPin[] {
  const root = path.resolve(projectPath);
  // A web address is not a file here: `curl https://x.example/a.sh` would
  // otherwise read as `<project>/https:/x.example/a.sh`, a file that never exists.
  const local = commands.map((command) => command.replace(URL_WORD, ' '));
  return namedTargets(root, path.resolve(dorkHome, 'plugins'), local)
    .map((abs): HookScriptPin => [
      isInside(root, abs) ? path.relative(root, abs).split(path.sep).join('/') : abs,
      fileFingerprint(abs),
    ])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Say which files a card's yes covers, with a short hash a reviewer can match
 * against the file they read.
 *
 * @param scripts - The pins on the request.
 * @returns A clause like `hooks/loop.mjs (sha256 1a2b3c4d5e6f)`, or `''` when none.
 */
export function describeHookScriptPins(scripts: readonly HookScriptPin[]): string {
  return scripts
    .map(
      ([file, hash]) =>
        `${file} (${/^[0-9a-f]{64}$/.test(hash) ? `sha256 ${hash.slice(0, 12)}` : hash})`
    )
    .join(', ');
}
