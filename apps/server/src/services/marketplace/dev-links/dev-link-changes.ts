/**
 * What a change inside a dev-linked folder asks DorkOS to do (DOR-2696, spec
 * `marketplace-dev-link` §6): which paths are never watched, which paths are
 * declarations at all, how a burst of changes is classified, and the cheap
 * listing the sweep compares. Pure apart from {@link shapeOf}, which reads the
 * folder.
 *
 * @module services/marketplace/dev-links/dev-link-changes
 */
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  CLAUDE_PLUGIN_MANIFEST_PATH,
  EFFECT_BEARING_PATHS,
  PACKAGE_MANIFEST_PATH,
} from '@dorkos/marketplace';
import { isRuntimeStatePath } from '../lib/content-hash.js';

/**
 * Directory names never watched anywhere inside a linked folder, compared
 * lowercased: version control, dependencies, and Python's virtual
 * environments and bytecode caches (a `.venv` alone can hold more folders
 * than a watch can open). No package names a skill or extension like these.
 */
const ALWAYS_IGNORED_DIR_NAMES = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);

/**
 * Build and coverage output folder names, compared lowercased: ignored too
 * (a Rust `target/` is as large as a `.venv`), except where the name is a
 * package's own choice ({@link isPackageNamed}): a skill, command or extension
 * called `build` or `dist`, or a folder on the way to a path plugin.json names.
 * A build folder inside one of those (`.dork/extensions/dash/dist`) is still
 * ignored.
 */
const BUILD_DIR_NAMES = new Set(['target', 'dist', 'build', '.next', 'coverage']);

/**
 * The folders whose direct children a package names itself: each skill,
 * command, task, extension, agent and output style.
 */
const NAMED_CHILD_CONTAINERS = new Set<string>([
  EFFECT_BEARING_PATHS.skills,
  EFFECT_BEARING_PATHS.commands,
  EFFECT_BEARING_PATHS.tasks,
  EFFECT_BEARING_PATHS.extensions,
  EFFECT_BEARING_PATHS.agents,
  EFFECT_BEARING_PATHS.outputStyles,
  '.claude/agents',
  '.claude/output-styles',
]);

/**
 * File names an editor or the OS leaves beside real files: Finder's
 * `.DS_Store`, Vim's swap and write-test files, Emacs's lock and autosave
 * files, and backup copies ending in `~`. They are never a declaration, even
 * inside `skills/`.
 */
const JUNK_FILE = /^(?:\.ds_store|4913|\.#.*|#.*#|.*~|.*\.sw[a-p])$/;

/** Where a package carries its extensions, relative to its folder. */
const EXTENSIONS_REL = EFFECT_BEARING_PATHS.extensions;

/**
 * What Harness Sync reads from a package to project it into a project
 * (`@dorkos/harness` `sources/installed.ts`): both manifests, the hooks file,
 * skills, tasks and commands, plus a skill pack's root `SKILL.md`.
 */
const PROJECTED_PATHS = [
  PACKAGE_MANIFEST_PATH,
  CLAUDE_PLUGIN_MANIFEST_PATH,
  EFFECT_BEARING_PATHS.hooks,
  EFFECT_BEARING_PATHS.skills,
  EFFECT_BEARING_PATHS.rootSkill,
  EFFECT_BEARING_PATHS.commands,
  EFFECT_BEARING_PATHS.tasks,
] as const;

/**
 * What the runtime's plugin list and global consent read from a package by
 * default: the manifests and every file `readRunnableDeclarations` reads
 * (`preview/permission-preview.ts`): hooks, MCP and language servers,
 * monitors, `bin/`, skills, commands, and agent and output-style files.
 * Paths a plugin.json names elsewhere are added per folder
 * ({@link declaredPathsOf}).
 */
const DECLARATION_PATHS = [
  PACKAGE_MANIFEST_PATH,
  '.claude-plugin',
  EFFECT_BEARING_PATHS.hooks,
  EFFECT_BEARING_PATHS.mcpServersFile,
  EFFECT_BEARING_PATHS.lspServersFile,
  EFFECT_BEARING_PATHS.monitors,
  EFFECT_BEARING_PATHS.executables,
  EFFECT_BEARING_PATHS.skills,
  EFFECT_BEARING_PATHS.rootSkill,
  EFFECT_BEARING_PATHS.commands,
  EFFECT_BEARING_PATHS.agents,
  EFFECT_BEARING_PATHS.outputStyles,
  '.claude/agents',
  '.claude/output-styles',
] as const;

/** The plugin.json fields that can name a declaration file somewhere else. */
const DECLARING_FIELDS = ['hooks', 'mcpServers', 'lspServers', 'monitors', 'skills', 'commands'];

/**
 * The directories the sweep lists one level deep, relative to the folder: the
 * folder itself (for root files such as `.mcp.json` and folders that come or
 * go) and `.dork` (for its manifest).
 */
const SHALLOW_SWEPT_DIRS = ['', '.dork'] as const;

/**
 * The paths the sweep lists all the way down: every place a declaration or an
 * extension lives, plus each path plugin.json names. A file a dropped event
 * never reported, deep in a skill or an extension, is still found.
 */
const DEEP_SWEPT_PATHS = [
  '.claude-plugin',
  EXTENSIONS_REL,
  EFFECT_BEARING_PATHS.tasks,
  EFFECT_BEARING_PATHS.skills,
  EFFECT_BEARING_PATHS.commands,
  EFFECT_BEARING_PATHS.hooks,
  EFFECT_BEARING_PATHS.executables,
  EFFECT_BEARING_PATHS.monitors,
  EFFECT_BEARING_PATHS.agents,
  EFFECT_BEARING_PATHS.outputStyles,
  '.claude/agents',
  '.claude/output-styles',
] as const;

/** How deep the sweep descends below a deep path. */
const SWEEP_MAX_DEPTH = 8;

/**
 * The most entries one sweep lists, so a folder that grew a huge tree under a
 * declaration path costs a bounded read. The watch still sees everything.
 */
const SWEEP_MAX_ENTRIES = 20_000;

/** A filesystem event, as chokidar names it. */
export type DevLinkChangeKind = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';

/** One change inside a linked folder. */
export interface DevLinkChange {
  /** POSIX path relative to the folder; `''` is the folder itself. */
  rel: string;
  /** What happened to it. */
  kind: DevLinkChangeKind;
}

/** What a burst of changes asks for. */
export interface DevLinkReloadPlan {
  /** Extension folder names (under `.dork/extensions`) to rebuild, sorted. */
  reload: string[];
  /** Re-scan every extension before rebuilding any. */
  refreshExtensions: boolean;
  /** Run a project dev link's harness projection again. */
  projection: boolean;
  /** Refresh the runtime's plugin list and check what the package runs again. */
  plugins: boolean;
}

/**
 * Whether a path inside a linked folder is never watched or acted on: anything
 * inside an {@link ALWAYS_IGNORED_DIR_NAMES} folder (any case); anything inside
 * a {@link BUILD_DIR_NAMES} folder the package did not name itself
 * ({@link isPackageNamed}); such a folder itself when it is known to be one;
 * and DorkOS's own runtime state (`isRuntimeStatePath`: saved data, secrets,
 * install records).
 *
 * A last segment is only ignored by those names as a directory, so a program
 * named `build` is still a change. Editor and OS leftovers ({@link JUNK_FILE})
 * are ignored as files.
 *
 * @param rel - POSIX path relative to the folder.
 * @param isDirectory - Whether `rel` is known to be a directory.
 * @param declared - Extra declaration paths from the folder's plugin.json
 *   ({@link declaredPathsOf}); a build-named folder on the way to one is kept.
 */
export function isIgnoredDevLinkPath(
  rel: string,
  isDirectory = false,
  declared: readonly string[] = []
): boolean {
  if (rel === '') return false;
  const original = rel.split('/');
  const segments = rel.toLowerCase().split('/');
  const last = segments.length - 1;
  const ignoredAt = (segment: string, i: number): boolean =>
    (i < last || isDirectory) &&
    (ALWAYS_IGNORED_DIR_NAMES.has(segment) ||
      (BUILD_DIR_NAMES.has(segment) && !isPackageNamed(original.slice(0, i + 1), declared)));
  if (segments.some(ignoredAt)) return true;
  if (!isDirectory && JUNK_FILE.test(segments[last]!)) return true;
  return isRuntimeStatePath(rel);
}

/**
 * Whether a build-named folder is one the package named itself: the direct
 * child of a {@link NAMED_CHILD_CONTAINERS} folder (`skills/build`, an
 * extension called `dist`), or on the way to a path plugin.json names (`dist`
 * for `dist/hooks.json`).
 *
 * @param segments - The folder's path, split, original case.
 * @param declared - Extra declaration paths from the folder's plugin.json.
 */
function isPackageNamed(segments: readonly string[], declared: readonly string[]): boolean {
  const folder = segments.join('/');
  return (
    NAMED_CHILD_CONTAINERS.has(segments.slice(0, -1).join('/')) ||
    declared.some((path) => under(path, folder))
  );
}

/** Whether `rel` is `prefix` or lies under it. */
function under(rel: string, prefix: string): boolean {
  return rel === prefix || rel.startsWith(`${prefix}/`);
}

/**
 * The package-relative paths a plugin.json names for its declarations, beyond
 * the default files: string values (or string items) of `hooks`,
 * `mcpServers`, `lspServers`, `monitors` (or `experimental.monitors`),
 * `skills` and `commands`. A change under one of them is a plugin change.
 *
 * @param pluginJson - The parsed `.claude-plugin/plugin.json`, when readable.
 * @returns POSIX paths, `./` and trailing `/` removed; never one leaving the folder.
 */
export function declaredPathsOf(pluginJson: Record<string, unknown> | undefined): string[] {
  if (!pluginJson) return [];
  const experimental = pluginJson.experimental;
  const values = DECLARING_FIELDS.map((field) =>
    field === 'monitors' &&
    typeof experimental === 'object' &&
    experimental !== null &&
    'monitors' in experimental
      ? (experimental as Record<string, unknown>).monitors
      : pluginJson[field]
  );
  const paths = new Set<string>();
  for (const value of values) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== 'string') continue;
      const rel = path.posix.normalize(item.split('\\').join('/')).replace(/\/+$/, '');
      if (rel === '' || rel === '.' || rel === '..' || rel.startsWith('../')) continue;
      if (path.posix.isAbsolute(rel)) continue;
      paths.add(rel);
    }
  }
  return [...paths].sort();
}

/** Whether a path is one the projection or the plugin list reads. */
function declarationKinds(
  rel: string,
  declared: readonly string[]
): { projection: boolean; plugins: boolean } {
  return {
    projection: PROJECTED_PATHS.some((prefix) => under(rel, prefix)),
    plugins:
      DECLARATION_PATHS.some((prefix) => under(rel, prefix)) ||
      declared.some((prefix) => under(rel, prefix)),
  };
}

/**
 * Whether `rel` is a folder that holds a declaration path or the extensions
 * (`.dork`, `.claude`): one appearing or going away takes them with it.
 */
function holdsDeclarations(rel: string, declared: readonly string[]): boolean {
  return [EXTENSIONS_REL, ...DECLARATION_PATHS, ...PROJECTED_PATHS, ...declared].some(
    (p) => p !== rel && under(p, rel)
  );
}

/** Whether `kind` names a directory. */
function isDirKind(kind: DevLinkChangeKind): boolean {
  return kind === 'addDir' || kind === 'unlinkDir';
}

/**
 * Whether a change can ask for anything at all: not ignored, and inside the
 * extensions folder or a path the projection or the plugin list reads. A
 * README, `src/`, a log, `.DS_Store` or an editor's swap file never does.
 *
 * @param change - The change.
 * @param declared - Extra declaration paths from the folder's plugin.json.
 */
export function isDevLinkDeclarationChange(
  { rel, kind }: DevLinkChange,
  declared: readonly string[] = []
): boolean {
  if (isIgnoredDevLinkPath(rel, isDirKind(kind), declared)) return false;
  if (under(rel, EXTENSIONS_REL)) return true;
  if (isDirKind(kind) && holdsDeclarations(rel, declared)) return true;
  const kinds = declarationKinds(rel, declared);
  return kinds.projection || kinds.plugins;
}

/**
 * Decide what a burst of changes asks for. Pure.
 *
 * | Changed path                                                 | Asks for            |
 * | ------------------------------------------------------------ | ------------------- |
 * | `.dork/extensions/<dir>/**`, `<dir>` known                   | rebuild `<dir>`     |
 * | `.dork/extensions/<dir>/extension.json`, known               | re-scan, rebuild    |
 * | a new or removed `.dork/extensions/<dir>`, or an unknown one | re-scan             |
 * | both manifests, `hooks/**`, `skills/**`, `commands/**`, root `SKILL.md` | projection and plugins |
 * | `.dork/tasks/**`                                             | projection          |
 * | `.mcp.json`, `.lsp.json`, `monitors/**`, `bin/**`, `agents/**`, `output-styles/**`, a path plugin.json names | plugins |
 * | anything else (README, `src/`, logs, swap files)             | nothing             |
 *
 * Skills, commands and hooks ask for both because their frontmatter and files
 * declare hooks the package runs on its own, which global consent re-checks.
 *
 * @param changes - The burst, in any order.
 * @param knownExtensionDirs - Extension folder names DorkOS already has a
 *   record for, from this linked folder.
 * @param declared - Extra declaration paths from the folder's plugin.json
 *   ({@link declaredPathsOf}).
 */
export function classifyDevLinkChanges(
  changes: readonly DevLinkChange[],
  knownExtensionDirs: ReadonlySet<string>,
  declared: readonly string[] = []
): DevLinkReloadPlan {
  const reload = new Set<string>();
  let refreshExtensions = false;
  let projection = false;
  let plugins = false;
  for (const change of changes) {
    const { rel, kind } = change;
    if (!isDevLinkDeclarationChange(change, declared)) continue;
    if (under(rel, EXTENSIONS_REL)) {
      const parts = rel.split('/');
      const dir = parts[2];
      if (dir === undefined) {
        refreshExtensions = true;
        continue;
      }
      const known = knownExtensionDirs.has(dir);
      if (parts.length === 3) {
        // The extension's own folder: appearing or going away is a re-scan; a
        // sweep's "something in it changed" is a rebuild when it is known.
        if (kind === 'change' && known) reload.add(dir);
        else refreshExtensions = true;
        continue;
      }
      if (!known) {
        refreshExtensions = true;
        continue;
      }
      if (parts.length === 4 && parts[3] === 'extension.json') refreshExtensions = true;
      reload.add(dir);
      continue;
    }
    const kinds = declarationKinds(rel, declared);
    // A folder holding declarations (`.dork`, `.claude`) that came or went.
    const parent = isDirKind(kind) && holdsDeclarations(rel, declared);
    if (parent && under(EXTENSIONS_REL, rel)) refreshExtensions = true;
    projection ||= kinds.projection || parent;
    plugins ||= kinds.plugins || parent;
  }
  return { reload: [...reload].sort(), refreshExtensions, projection, plugins };
}

/**
 * POSIX path of `abs` relative to `folder`, or `null` when it is outside.
 *
 * @param folder - The linked folder.
 * @param abs - An absolute path.
 */
export function relativeTo(folder: string, abs: string): string | null {
  const rel = path.relative(folder, abs);
  // `..foo` is a name inside the folder; only `..` itself, or a path through
  // it, climbs out.
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** The sweep's listing of a folder: signature by folder-relative path. */
export type DevLinkShape = Map<string, string>;

/** A path's signature in a {@link DevLinkShape}: `d` for a directory, `mtime:size` otherwise. */
async function signatureOf(
  folder: string,
  rel: string,
  declared: readonly string[]
): Promise<{ signature: string; isDirectory: boolean } | null> {
  const stats = await lstat(path.join(folder, rel)).catch(() => null);
  if (!stats) return null;
  const isDirectory = stats.isDirectory();
  if (isIgnoredDevLinkPath(rel, isDirectory, declared)) return null;
  return { signature: isDirectory ? 'd' : `${stats.mtimeMs}:${stats.size}`, isDirectory };
}

/**
 * A cheap listing of where a folder's declarations and extensions live, keyed
 * by folder-relative path: the folder and `.dork` one level deep, every
 * declaration path, the extensions and each declared path all the way down
 * (bounded). A file carries its modification time and size; a directory
 * carries only that it is one, so something appearing inside an ignored
 * folder (`node_modules` filling up, `.dork/data` being written) never reads
 * as a change. Ignored paths are left out, and links are not followed.
 *
 * A folder with more than `maxEntries` there gets no listing at all: a cut
 * listing depends on walk order, so comparing two of them would report
 * changes that never happened.
 *
 * @param folder - The linked folder.
 * @param declared - Extra declaration paths from the folder's plugin.json.
 * @param maxEntries - The most entries listed; defaults to {@link SWEEP_MAX_ENTRIES}.
 * @returns The listing, or `null` when the folder holds more than `maxEntries`.
 */
export async function shapeOf(
  folder: string,
  declared: readonly string[] = [],
  maxEntries = SWEEP_MAX_ENTRIES
): Promise<DevLinkShape | null> {
  const shape: DevLinkShape = new Map();
  let capped = false;
  const record = async (rel: string): Promise<boolean | null> => {
    if (shape.size >= maxEntries) {
      capped = true;
      return null;
    }
    const found = await signatureOf(folder, rel, declared);
    if (!found) return null;
    shape.set(rel, found.signature);
    return found.isDirectory;
  };
  const children = async (rel: string): Promise<string[]> =>
    ((await readdir(path.join(folder, rel)).catch(() => [])) as string[])
      .sort()
      .map((name) => (rel === '' ? name : `${rel}/${name}`));

  for (const rel of SHALLOW_SWEPT_DIRS) {
    for (const child of await children(rel)) await record(child);
  }
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (capped) return;
    const isDirectory = await record(rel);
    if (!isDirectory || depth >= SWEEP_MAX_DEPTH) return;
    for (const child of await children(rel)) await walk(child, depth + 1);
  };
  for (const rel of [...DEEP_SWEPT_PATHS, ...declared]) await walk(rel, 0);
  return capped ? null : shape;
}

/** Whether {@link shapeOf} lists `rel` (ignoring whether it exists). */
function isListed(rel: string, declared: readonly string[]): boolean {
  const parts = rel.split('/');
  const parent = parts.slice(0, -1).join('/');
  if ((SHALLOW_SWEPT_DIRS as readonly string[]).includes(parent)) return true;
  return [...DEEP_SWEPT_PATHS, ...declared].some(
    (root) => under(rel, root) && parts.length - root.split('/').length <= SWEEP_MAX_DEPTH
  );
}

/**
 * Bring a listing up to date with the changes just acted on, reading only
 * those paths, so the next sweep does not act on them again. The full walk
 * belongs to the sweep and to arming a watch; a burst touches a few paths.
 *
 * @param folder - The linked folder.
 * @param shape - The listing to update in place.
 * @param changes - The changes just acted on.
 * @param declared - Extra declaration paths from the folder's plugin.json.
 */
export async function updateShape(
  folder: string,
  shape: DevLinkShape,
  changes: readonly DevLinkChange[],
  declared: readonly string[] = []
): Promise<void> {
  for (const { rel } of changes) {
    if (rel === '') continue;
    const found = isListed(rel, declared) ? await signatureOf(folder, rel, declared) : null;
    if (found) {
      shape.set(rel, found.signature);
      continue;
    }
    // Gone (or no longer listed): so is everything under it.
    shape.delete(rel);
    for (const key of [...shape.keys()]) if (key.startsWith(`${rel}/`)) shape.delete(key);
  }
}

/**
 * The entries whose listing differs, as changes to act on.
 *
 * @param before - The listing last acted on.
 * @param after - The listing now.
 */
export function shapeChanges(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>
): DevLinkChange[] {
  const changes: DevLinkChange[] = [];
  for (const rel of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(rel);
    const is = after.get(rel);
    if (was === is) continue;
    if (was === undefined) changes.push({ rel, kind: is === 'd' ? 'addDir' : 'add' });
    else if (is === undefined) changes.push({ rel, kind: was === 'd' ? 'unlinkDir' : 'unlink' });
    else changes.push({ rel, kind: 'change' });
  }
  return changes;
}
