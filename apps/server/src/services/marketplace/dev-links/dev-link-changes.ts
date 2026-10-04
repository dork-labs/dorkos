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
 * lowercased: version control, dependencies, and the build, cache and virtual
 * environment folders a toolchain fills (a Rust `target/` or a Python `.venv`
 * alone can hold more folders than a watch can open). Nothing a package
 * declares is read from inside one of them.
 */
const IGNORED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'target',
  '.venv',
  'venv',
  'dist',
  'build',
  '__pycache__',
  '.next',
  'coverage',
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
 * The directories the sweep lists, relative to the folder. Each extension's own
 * folder is added per pass. Deeper edits are left to the watch, which in a
 * steady state misses nothing (`skills-watcher.ts`).
 */
const SWEPT_DIRS = [
  '',
  '.claude-plugin',
  '.dork',
  EXTENSIONS_REL,
  EFFECT_BEARING_PATHS.tasks,
  EFFECT_BEARING_PATHS.skills,
  EFFECT_BEARING_PATHS.commands,
  EFFECT_BEARING_PATHS.hooks,
  EFFECT_BEARING_PATHS.executables,
  EFFECT_BEARING_PATHS.monitors,
  EFFECT_BEARING_PATHS.agents,
  EFFECT_BEARING_PATHS.outputStyles,
] as const;

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
 * inside an {@link IGNORED_DIR_NAMES} folder (any case), such a folder itself
 * when it is known to be one, and DorkOS's own runtime state
 * (`isRuntimeStatePath`: saved data, secrets, install records).
 *
 * A last segment is only ignored by those names as a directory, so a program
 * named `bin/build` is still a change. Editor and OS leftovers
 * ({@link JUNK_FILE}) are ignored as files.
 *
 * @param rel - POSIX path relative to the folder.
 * @param isDirectory - Whether `rel` is known to be a directory.
 */
export function isIgnoredDevLinkPath(rel: string, isDirectory = false): boolean {
  if (rel === '') return false;
  const segments = rel.toLowerCase().split('/');
  const last = segments.length - 1;
  if (segments.some((segment, i) => (i < last || isDirectory) && IGNORED_DIR_NAMES.has(segment))) {
    return true;
  }
  if (!isDirectory && JUNK_FILE.test(segments[last]!)) return true;
  return isRuntimeStatePath(rel);
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
  if (isIgnoredDevLinkPath(rel, isDirKind(kind))) return false;
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

/**
 * A cheap listing of a folder's meaningful directories: one entry per child,
 * keyed by its folder-relative path. A file carries its modification time and
 * size; a directory carries only that it is one, so a change deeper inside it
 * (an ignored `node_modules` filling up, `.dork/data` being written) never
 * reads as a change here. Ignored paths are left out.
 *
 * @param folder - The linked folder.
 * @returns Signature by child path: `d` for a directory, `mtime:size` otherwise.
 */
export async function shapeOf(folder: string): Promise<Map<string, string>> {
  const shape = new Map<string, string>();
  const extensionDirs = await readdir(path.join(folder, EXTENSIONS_REL), {
    withFileTypes: true,
  }).catch(() => []);
  const dirs = [
    ...SWEPT_DIRS,
    ...extensionDirs
      .filter((entry) => entry.isDirectory() && !isIgnoredDevLinkPath(entry.name, true))
      .map((entry) => `${EXTENSIONS_REL}/${entry.name}`),
  ];
  for (const rel of dirs) {
    const abs = path.join(folder, rel);
    const entries = await readdir(abs).catch(() => null);
    if (entries === null) continue;
    for (const name of entries.sort()) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const stats = await lstat(path.join(abs, name)).catch(() => null);
      if (!stats) continue;
      const isDirectory = stats.isDirectory();
      if (isIgnoredDevLinkPath(childRel, isDirectory)) continue;
      shape.set(childRel, isDirectory ? 'd' : `${stats.mtimeMs}:${stats.size}`);
    }
  }
  return shape;
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
