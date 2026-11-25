/**
 * On macOS, turn each deep deny glob (a base folder, then `**`, then a name)
 * into exact denies for the files that match (DOR-4358).
 *
 * Codex 0.163's Seatbelt profile adds, for every deny key with a wildcard,
 * `(deny file-write-unlink (require-all (vnode-type DIRECTORY) (regex …)))`
 * over the folders that could hold a match. With `**` that is every folder
 * under the base: no folder under the agent's folder or the home folder can be
 * removed or renamed, so `rm -rf`, `npm ci` and a test fixture's teardown all
 * fail with EPERM while removing files still works. An exact deny gets the
 * same guard on its own parent folders only (checked on the binary: moving
 * the parent or a grandparent, renaming the file and hard-linking it are all
 * refused), so every other folder stays free.
 *
 * The profile renders on every turn, so a file that appears is named exactly
 * from the next render on (DOR-4358), and that render writes an Activity line
 * naming it (`secret-file-activity.ts`).
 *
 * The folders the agent works in are scanned on every render (a repo takes
 * well under a second). Every other base (the home, data and account folders)
 * is scanned in the background at most every {@link BACKGROUND_SCAN_EVERY_MS},
 * because a whole-home scan can take ~20 s, and a folder watch keeps that
 * result current: each render first looks at the paths that changed since the
 * last one, so a file that appears there is named at the next render too.
 *
 * Fail closed, always: a base keeps its `**` keys when it can't be read, when
 * its scan errors, times out or hasn't finished, when it holds a folder the
 * person owns but has shut by its mode bits (the agent could open it again with
 * `chmod`), when its last result skipped a folder this render does not deny
 * whole, when its last result is older than {@link BACKGROUND_RESULT_MAX_AGE_MS},
 * when its watch failed, lost track or saw more changes than it may hold,
 * when a changed folder is too big to look through, when a match's path holds
 * a backslash, or when its exact rules would pass {@link MAX_EXACT_RULES}
 * (Codex passes the profile on one command line, and ~1,800 rules overflow
 * it). Keeping them protects the secrets and only brings the folder lock back
 * for that base.
 *
 * What is never scanned: symlinks (`rg` doesn't follow them), `node_modules`
 * (public package files, which often ship test `*.pem` keys or an `.npmrc`),
 * git's content-addressed objects (whose hex names can match no protected
 * name) and folders the profile already denies whole. A git-tracked,
 * unmodified `.npmrc` stays readable; the home folder's own `~/.npmrc` is an
 * exact deny that never passes here.
 *
 * @module services/runtimes/codex/policy/expand-deep-globs
 */
import fs from 'node:fs';
import path from 'node:path';
import { ripgrepScanner, type DeepGlobScanner } from './deep-glob-rg.js';
import { resetTrackedLookups, settleTrackedLookups } from './tracked-npmrc.js';

export { ripgrepScanner, type DeepGlobScanner } from './deep-glob-rg.js';

type Access = 'read' | 'deny';

/** The most exact rules one profile may gain; past this a base keeps its globs. */
export const MAX_EXACT_RULES = 400;
/** How often, at most, a background base is scanned again. */
export const BACKGROUND_SCAN_EVERY_MS = 5 * 60_000;
/** A background result older than this is not used; the base keeps its globs. */
export const BACKGROUND_RESULT_MAX_AGE_MS = 15 * 60_000;
/** The most changed paths a watch holds between renders; past it, a fresh scan. */
export const MAX_WATCHED_CHANGES = 20_000;
/** The most entries looked through in one changed folder; past it, a fresh scan. */
export const MAX_FOLDER_WALK = 2_000;

/** Where a deep glob splits into its base folder and the name it matches. */
const DEEP = '/**/';
/** A deep folder rule's companion key, which covers the folder's contents. */
const CONTENTS = '/**';
/** Characters that make a profile key a glob rather than a literal path. */
const GLOB = /[*?[\]{}]/;
/** The project file whose tracked copy stays readable (Security, DOR-4358). */
const TRACKED_READABLE_NAME = '.npmrc';
/**
 * Folders never scanned, at any depth: `node_modules` holds public package
 * files, and git's objects are named by hash, so no protected name matches.
 */
const NEVER_SCANNED = ['node_modules', '.git/objects'];

/** What {@link expandDeepGlobs} needs beyond the entries. */
export interface ExpandDeepGlobsOptions {
  /** The platform the profile is rendered for; only `darwin` expands. */
  platform: NodeJS.Platform;
  /** Folders the agent works in: a base inside one is scanned on every render. */
  working: readonly string[];
  /** How to scan; the vendored `rg` by default. */
  scanner?: DeepGlobScanner;
  /** The clock; tests pass their own. */
  now?: () => number;
  /**
   * Told each base whose globs became exact rules, with those rules.
   *
   * @param base - The base folder.
   * @param keys - Its exact deny keys.
   */
  onExact?: (base: string, keys: ReadonlySet<string>) => void;
}

/** One name a base's deep keys match, as a file or as a folder and its contents. */
interface DeepPattern {
  readonly tail: string;
  readonly folder: boolean;
  readonly keys: string[];
  /** File: the matching path. Folder: the matching folder above a path. */
  readonly match: RegExp;
}

/** One background base: its last result, the scan in flight, and the watch keeping it current. */
interface BackgroundScan {
  /** The last finished result, or none when it can't be vouched for. */
  files?: Set<string>;
  /** The folders the finished scan skipped (its `!` globs). */
  skipped?: readonly string[];
  finishedAt?: number;
  startedAt?: number;
  running?: Promise<void>;
  watch?: { close(): void };
  /** Paths changed since the last render looked, relative to the base. */
  changed: Set<string>;
  /** Paths changed since the running scan started; replayed when it lands. */
  sinceStart?: Set<string>;
  /** Bumped whenever the watch loses track; a scan from before is thrown away. */
  generation: number;
}

const background = new Map<string, BackgroundScan>();

/** A tail's name as a regex body: `*` matches within one path segment. */
function tailSource(tail: string): string {
  return tail
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
}

/**
 * Where `relative` matches the pattern: the file itself, or for a folder
 * pattern the matching folder above it. `undefined` when it doesn't match.
 */
function matchOf(pattern: DeepPattern, relative: string): string | undefined {
  const found = pattern.match.exec(relative);
  return found === null ? undefined : pattern.folder ? found[1] : relative;
}

/** Whether `dir` is a real folder this process can see. */
function isFolder(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `dir` is `root` or inside it. */
function within(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(`${root}/`);
}

/** Whether a path relative to a base lies in a folder that is never scanned. */
function neverScanned(relative: string): boolean {
  return NEVER_SCANNED.some(
    (dir) => relative === dir || relative.startsWith(`${dir}/`) || relative.includes(`/${dir}/`)
  );
}

/**
 * A literal path spelled for a glob-free reading: each `*`, `?`, `[`, `{` and
 * `}` becomes a one-character class, which Seatbelt matches as the character
 * itself (checked on the binary, DOR-4542). A lone `]` stays plain. A
 * backslash, which Codex reads as an escape, can't be spelled: `undefined`.
 */
function exactSpelling(literal: string): string | undefined {
  if (literal.includes('\\')) return undefined;
  return literal.replace(/[*?[{}]/g, (char) => `[${char}]`);
}

/** Group the deep deny keys by base folder, merging a folder rule with its contents key. */
function deepPatternsByBase(entries: Readonly<Record<string, Access>>) {
  const byBase = new Map<string, Map<string, DeepPattern>>();
  for (const key of Object.keys(entries)) {
    const at = key.indexOf(DEEP);
    if (at <= 0 || entries[key] !== 'deny') continue;
    const base = key.slice(0, at);
    if (GLOB.test(base)) continue;
    let tail = key.slice(at + DEEP.length);
    const contents = tail.endsWith(CONTENTS);
    if (contents) tail = tail.slice(0, -CONTENTS.length);
    if (tail.length === 0 || tail.includes('**')) continue;
    const patterns = byBase.get(base) ?? new Map<string, DeepPattern>();
    const existing = patterns.get(tail);
    const folder = contents || existing?.folder === true || `${key}${CONTENTS}` in entries;
    const body = tailSource(tail);
    const match = folder ? new RegExp(`^((?:.*/)?${body})/`) : new RegExp(`(^|/)${body}$`);
    patterns.set(tail, { tail, folder, match, keys: [...(existing?.keys ?? []), key] });
    byBase.set(base, patterns);
  }
  return byBase;
}

/** The `rg` globs for a base: every pattern, then everything never scanned. */
function globsFor(
  base: string,
  patterns: readonly DeepPattern[],
  entries: Readonly<Record<string, Access>>
): string[] {
  const include = patterns.map((p) => (p.folder ? `**/${p.tail}/**` : `**/${p.tail}`));
  // A folder the profile already denies whole needs no scan: its files are covered.
  const deniedWhole = Object.keys(entries)
    .filter((key) => entries[key] === 'deny' && !GLOB.test(key) && key.startsWith(`${base}/`))
    .map((key) => `!${key.slice(base.length + 1)}/**`);
  return [...include, ...NEVER_SCANNED.map((dir) => `!**/${dir}/**`), ...deniedWhole];
}

/** Forget a background result the watch can no longer vouch for, and stop the watch. */
function loseTrack(scan: BackgroundScan): void {
  scan.generation += 1;
  scan.files = undefined;
  scan.watch?.close();
  scan.watch = undefined;
  scan.changed.clear();
  scan.sinceStart = undefined;
}

/** Note one path the watch saw change; too many, or an unnamed one, loses track. */
function noteChange(scan: BackgroundScan, name: string | null): void {
  if (name === null || scan.changed.size >= MAX_WATCHED_CHANGES) return loseTrack(scan);
  const relative = name.split(path.sep).join('/');
  if (neverScanned(relative)) return;
  scan.changed.add(relative);
  scan.sinceStart?.add(relative);
}

/**
 * Bring a result up to date with paths that changed under `base`: a path
 * that is gone takes everything under it; a file that matches is added; a
 * folder (made, or moved in with its contents) is looked through. `false`
 * when a folder is too big to look through, so the result can't be vouched for.
 */
function applyChanges(
  files: Set<string>,
  base: string,
  patterns: readonly DeepPattern[],
  changed: Iterable<string>
): boolean {
  const matches = (relative: string) => patterns.some((p) => matchOf(p, relative) !== undefined);
  for (const relative of changed) {
    const full = `${base}/${relative}`;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(full);
    } catch {
      files.delete(full);
      for (const file of files) if (file.startsWith(`${full}/`)) files.delete(file);
      continue;
    }
    if (!stat.isDirectory()) {
      if (matches(relative)) files.add(full);
      continue;
    }
    const stack = [relative];
    let seen = 0;
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let names: fs.Dirent[];
      try {
        names = fs.readdirSync(`${base}/${dir}`, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of names) {
        if ((seen += 1) > MAX_FOLDER_WALK) return false;
        const inner = `${dir}/${entry.name}`;
        if (neverScanned(inner)) continue;
        if (entry.isDirectory()) stack.push(inner);
        else if (matches(inner)) files.add(`${base}/${inner}`);
      }
    }
  }
  return true;
}

/**
 * A background base's last usable result, kept current by its watch, starting
 * a fresh scan when the last one began at least {@link BACKGROUND_SCAN_EVERY_MS}
 * ago. `null` until a scan has finished, and whenever the result can't be
 * vouched for.
 */
function backgroundFiles(
  base: string,
  patterns: readonly DeepPattern[],
  globs: readonly string[],
  scanner: DeepGlobScanner,
  now: () => number
): string[] | null {
  // Keyed by what is searched for, not by the skipped folders: those change
  // whenever a denied folder appears, and a new key would mean a new scan and a
  // thread reload each time.
  const key = `${base}\0${globs.filter((glob) => !glob.startsWith('!')).join('\0')}`;
  const skipping = globs.filter((glob) => glob.startsWith('!'));
  const scan = background.get(key) ?? { changed: new Set<string>(), generation: 0 };
  background.set(key, scan);
  // First the paths changed since the last render; one that can't be followed
  // loses track, and the watch and a scan start again below.
  if (scan.files !== undefined && scan.changed.size > 0) {
    const changed = [...scan.changed];
    scan.changed.clear();
    if (!applyChanges(scan.files, base, patterns, changed)) loseTrack(scan);
  }
  if (scan.watch === undefined) {
    // Watch first, then scan: nothing that changes in between is missed.
    loseTrack(scan);
    const watch = scanner.watch(base, {
      change: (name) => noteChange(scan, name),
      fail: () => loseTrack(scan),
    });
    if (watch === null) return null;
    scan.watch = watch;
    scan.startedAt = undefined;
  }
  // A result that skipped a folder this render no longer denies whole never
  // looked inside it, so it can't vouch for that folder: scan again now.
  const covers = (scan.skipped ?? []).every((glob) => skipping.includes(glob));
  const due =
    !covers || scan.startedAt === undefined || now() - scan.startedAt >= BACKGROUND_SCAN_EVERY_MS;
  if (scan.running === undefined && due) {
    const generation = scan.generation;
    const sinceStart = new Set<string>();
    scan.startedAt = now();
    scan.sinceStart = sinceStart;
    scan.running = scanner
      .filesLater(base, globs)
      .then((files) => {
        if (files === null || scan.generation !== generation) return;
        const next = new Set(files);
        if (!applyChanges(next, base, patterns, sinceStart)) return loseTrack(scan);
        scan.files = next;
        scan.skipped = skipping;
        scan.finishedAt = now();
        scan.changed.clear();
      })
      .catch(() => undefined)
      .finally(() => {
        scan.running = undefined;
        if (scan.sinceStart === sinceStart) scan.sinceStart = undefined;
      });
  }
  const fresh =
    scan.finishedAt !== undefined && now() - scan.finishedAt <= BACKGROUND_RESULT_MAX_AGE_MS;
  return fresh && covers && scan.files !== undefined ? [...scan.files] : null;
}

/**
 * The exact keys a base's matching files become, or `null` when one can't be
 * spelled exactly (the base then keeps its globs).
 *
 * @param base - The scanned base folder.
 * @param files - The base's matching files.
 * @param patterns - What the base's deep keys match.
 * @param tracked - Tracked, unchanged `.npmrc` files to leave readable.
 */
function exactKeys(
  base: string,
  files: readonly string[],
  patterns: readonly DeepPattern[],
  tracked: ReadonlySet<string>
): Set<string> | null {
  const keys = new Set<string>();
  for (const file of files) {
    const relative = path.relative(base, file).split(path.sep).join('/');
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    for (const pattern of patterns) {
      const match = matchOf(pattern, relative);
      if (match === undefined) continue;
      const literal = `${base}/${match}`;
      if (pattern.tail === TRACKED_READABLE_NAME && tracked.has(literal)) continue;
      const spelled = exactSpelling(literal);
      if (spelled === undefined) return null;
      keys.add(spelled);
    }
  }
  return keys;
}

/**
 * Replace each deep deny glob with exact denies for the files it matches.
 * Only on macOS; every other platform keeps the profile as it is.
 *
 * @param entries - The rendered profile filesystem entries.
 * @param options - The platform, the working folders, and how to scan.
 */
export function expandDeepGlobs(
  entries: Readonly<Record<string, Access>>,
  options: ExpandDeepGlobsOptions
): Record<string, Access> {
  const result: Record<string, Access> = { ...entries };
  if (options.platform !== 'darwin') return result;
  const scanner = options.scanner ?? ripgrepScanner;
  const now = options.now ?? Date.now;
  let budget = MAX_EXACT_RULES;
  for (const [base, byTail] of deepPatternsByBase(entries)) {
    if (!isFolder(base)) continue;
    const patterns = [...byTail.values()];
    const globs = globsFor(base, patterns, entries);
    const working = options.working.some((folder) => within(base, folder));
    const files = working
      ? scanner.files(base, globs)
      : backgroundFiles(base, patterns, globs, scanner, now);
    if (files === null) continue;
    const tracked =
      working && patterns.some((p) => p.tail === TRACKED_READABLE_NAME)
        ? scanner.trackedNpmrc(base)
        : new Set<string>();
    const keys = exactKeys(base, files, patterns, tracked);
    if (keys === null || keys.size > budget) continue;
    budget -= keys.size;
    for (const pattern of patterns) for (const key of pattern.keys) delete result[key];
    for (const key of keys) result[key] = 'deny';
    options.onExact?.(base, keys);
  }
  return result;
}

/**
 * Wait for the background scans and tracked-file lookups in flight, of one
 * base or of all.
 *
 * @param base - Only this base's; omitted, every one.
 * @internal Exported for tests.
 */
export async function settleBackgroundScans(base?: string): Promise<void> {
  const prefix = base === undefined ? undefined : `${base}\0`;
  await Promise.all([
    ...[...background.entries()]
      .filter(([key]) => prefix === undefined || key.startsWith(prefix))
      .map(([, scan]) => scan.running),
    settleTrackedLookups(base),
  ]);
}

/**
 * Forget every background result, watch and tracked-file answer, so each test
 * starts cold.
 *
 * @internal Exported for tests.
 */
export function resetBackgroundScans(): void {
  for (const scan of background.values()) scan.watch?.close();
  background.clear();
  resetTrackedLookups();
}
