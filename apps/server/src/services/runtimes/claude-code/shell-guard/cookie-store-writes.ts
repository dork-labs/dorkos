/**
 * The browser sign-in stores a shell command may never write (DOR-4136): the
 * saved session every agent browser starts from, the profiles DorkOS's own
 * browsers keep, and the desktop app's data folders. A command that writes one
 * could plant a sign-in every later agent browser starts with, or wipe the
 * person's own, so the shell guard refuses it below Full, the way it refuses a
 * write to an agent's setup files: a refusal, never an ask a person could save
 * as "always". At Full only the entries refused at every level stay: a Full
 * agent may save a sign-in (left to DOR-4102), but never rewrite the agent
 * browser's guard config.
 *
 * @module services/runtimes/claude-code/shell-guard/cookie-store-writes
 */
import path from 'node:path';
import {
  HOME_PERSON_ONLY_PATHS,
  PERSON_ONLY_DATA_PATHS,
  type ProtectedPath,
} from '../../shared/policy/protected-paths.js';

/** The data folder's person-only entries that hold a browser sign-in. */
const DATA_COOKIE_STORES: readonly ProtectedPath[] = PERSON_ONLY_DATA_PATHS.filter((entry) =>
  /^(browser\/|browser-profiles(\/\.binding-key)?$|local-browser\/saved-logins$)/.test(entry.path)
);

/** One cookie store, measured from a folder this launch knows. */
export interface CookieStoreRule {
  /** The folder the entry is measured from. */
  base: string;
  /** The entry's path below `base`, as a case-insensitive test. */
  test: RegExp;
  /** The entry's path before any wildcard, for a removal of a folder above it. */
  fixed: string;
}

/** A shared path's name as a regex body: `*` stays inside one name. */
function nameBody(entry: Pick<ProtectedPath, 'path' | 'kind'>): string {
  const escaped = entry.path
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return `${escaped}${entry.kind === 'folder' ? '(?:/.*)?' : ''}`;
}

/**
 * The cookie stores for one launch, under each spelling of its folders.
 *
 * @param roots - The data folder and the home folder.
 * @param spellings - A folder's spellings: as given and where it really is.
 * @param full - Whether the command runs at Full, which leaves out the entries refused below Full.
 */
export function cookieStoreRules(
  roots: { dorkHome: string; home: string },
  spellings: (folder: string) => string[],
  full = false
): CookieStoreRule[] {
  const measured: [ProtectedPath, string][] = [
    ...DATA_COOKIE_STORES.map((entry): [ProtectedPath, string] => [entry, roots.dorkHome]),
    ...HOME_PERSON_ONLY_PATHS.map((entry): [ProtectedPath, string] => [entry, roots.home]),
  ];
  return measured.flatMap(([entry, folder]) => {
    if (full && entry.belowFull) return [];
    const literal = entry.path.split('/').filter((_, i, all) => {
      return !all.slice(0, i + 1).some((one) => one.includes('*'));
    });
    return spellings(folder).map((base) => ({
      base,
      test: new RegExp(`^${nameBody(entry)}$`, 'i'),
      fixed: path.join(base, ...literal),
    }));
  });
}

/** Whether `child` is `parent` or below it, in any letter case. */
function within(parent: string, child: string): boolean {
  const relative = path.relative(parent.toLowerCase(), child.toLowerCase());
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Whether writing `target` writes a cookie store, or, for a whole-folder
 * removal, takes one with it.
 *
 * @param target - A resolved path the command writes.
 * @param whole - Whether the command removes the whole folder `target` names.
 * @param rules - This launch's {@link cookieStoreRules}.
 */
export function writesCookieStore(
  target: string,
  whole: boolean,
  rules: readonly CookieStoreRule[]
): boolean {
  return rules.some((rule) => {
    if (whole && within(target, rule.fixed)) return true;
    if (!within(rule.base, target)) return false;
    const relative = path.relative(rule.base.toLowerCase(), target.toLowerCase());
    return rule.test.test(relative.split(path.sep).join('/'));
  });
}

/** Whether a name could be part of a cookie store at all: a quick cut before any path is worked out. */
export function namesCookieStore(name: string): boolean {
  return /browser|storage-state|saved-logins|cookies|application support|appdata|\.config|dorkos/i.test(
    name
  );
}
