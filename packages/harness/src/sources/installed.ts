/**
 * Installed-plugin source scanner — discover marketplace-installed plugins and
 * the portable assets they contribute, across both install scopes.
 *
 * This is the projector's "port" for installed sources: `@dorkos/harness` is a
 * leaf package and cannot import the server's installed-scanner, so it reads the
 * documented on-disk layout itself, reusing `@dorkos/marketplace`'s canonical
 * manifest schema (a browser-safe sibling) to validate each `.dork/manifest.json`.
 *
 * Install roots (per the marketplace installer):
 * - global  — `${dorkHome}/plugins/<name>`
 * - project — `<projectRoot>/.dork/plugins/<name>`
 *
 * A plugin's portable, harness-readable assets are its skills (`skills/<name>/`)
 * and tasks (`.dork/tasks/<name>/`) — both `SKILL.md` directories — plus its
 * Claude-plugin hooks (`hooks/hooks.json`). Everything else (extensions,
 * adapters, mcp-servers, …) has no harness home and is dropped by the projector.
 *
 * @module sources/installed
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MarketplacePackageManifestSchema } from '@dorkos/marketplace';
import { scanSkillDirs, type SkillEntry } from '../scan/scanner.js';
import type { ClaudeHooksConfig } from '../generate/hooks.js';

/** Where an installed plugin lives — its install scope. */
export type InstalledScope = 'global' | 'project';

/** A marketplace-installed plugin and the portable assets it contributes. */
export interface InstalledPlugin {
  /** Package name (the manifest `name`), used as the projection namespace. */
  name: string;
  /** Package type: `plugin` | `skill-pack` | `adapter` | `agent`. */
  type: string;
  /** Which install root it came from. */
  scope: InstalledScope;
  /**
   * Repo-relative install directory (e.g. `.dork/plugins/<name>`). Present only
   * for project-scoped plugins — global plugins are not projected by a project
   * sync, so their on-disk paths are not resolved.
   */
  relDir?: string;
  /**
   * Portable skill directories (from `skills/` and `.dork/tasks/`), each a
   * `SKILL.md` directory with a repo-relative `sourceDir`. Empty for global
   * plugins. De-duplicated by name (a `skills/` entry wins over a same-named
   * `.dork/tasks/` entry).
   */
  skills: SkillEntry[];
  /** Claude-plugin hooks (`hooks/hooks.json`), normalized. Project scope only. */
  hooks?: ClaudeHooksConfig;
  /** Declared content layers from the manifest (informational). */
  layers: string[];
}

/** The minimal manifest fields the projector needs. */
interface PluginIdentity {
  name: string;
  type: string;
  layers: string[];
}

/** Read + validate a plugin's `.dork/manifest.json`; `undefined` if absent or invalid. */
function readPluginManifest(pluginDir: string): PluginIdentity | undefined {
  const manifestPath = join(pluginDir, '.dork', 'manifest.json');
  if (!existsSync(manifestPath)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return undefined;
  }
  const parsed = MarketplacePackageManifestSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return { name: parsed.data.name, type: parsed.data.type, layers: parsed.data.layers };
}

/** Read a plugin's Claude-plugin hooks (`hooks/hooks.json`), tolerating either shape. */
function readPluginHooks(pluginDir: string): ClaudeHooksConfig | undefined {
  const hooksPath = join(pluginDir, 'hooks', 'hooks.json');
  if (!existsSync(hooksPath)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(hooksPath, 'utf8'));
  } catch {
    return undefined;
  }
  // Accept both `{ hooks: {…} }` (settings-style) and a bare `{ Event: […] }` object.
  const hooks =
    raw && typeof raw === 'object' && 'hooks' in raw ? (raw as { hooks: unknown }).hooks : raw;
  if (!hooks || typeof hooks !== 'object') return undefined;
  return hooks as ClaudeHooksConfig;
}

/** Collect a project plugin's portable skill dirs (skills/ + .dork/tasks/), de-duped by name. */
function collectPortableSkills(pluginDir: string, relDir: string): SkillEntry[] {
  const skillEntries = scanSkillDirs(join(pluginDir, 'skills'), `${relDir}/skills`);
  const taskEntries = scanSkillDirs(join(pluginDir, '.dork', 'tasks'), `${relDir}/.dork/tasks`);
  const byName = new Map<string, SkillEntry>();
  for (const entry of [...skillEntries, ...taskEntries]) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry); // skills win over same-named tasks
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Scan one plugins root (global or project) into {@link InstalledPlugin}s.
 *
 * Project plugins live at `<projectRoot>/.dork/plugins/<name>`, so their repo-
 * relative `relDir` is the literal `.dork/plugins/<name>` — no `projectRoot`
 * needed to build it.
 */
function scanPluginsRoot(pluginsRoot: string, scope: InstalledScope): InstalledPlugin[] {
  if (!existsSync(pluginsRoot)) return [];
  const plugins: InstalledPlugin[] = [];
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginDir = join(pluginsRoot, entry.name);
    const manifest = readPluginManifest(pluginDir);
    if (!manifest) continue;

    if (scope === 'global') {
      // Global installs are reported but not projected by a project sync, so we
      // record identity only — no path resolution or asset enumeration.
      plugins.push({
        name: manifest.name,
        type: manifest.type,
        scope,
        skills: [],
        layers: manifest.layers,
      });
      continue;
    }

    const relDir = `.dork/plugins/${entry.name}`;
    plugins.push({
      name: manifest.name,
      type: manifest.type,
      scope,
      relDir,
      skills: collectPortableSkills(pluginDir, relDir),
      hooks: readPluginHooks(pluginDir),
      layers: manifest.layers,
    });
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Discover all marketplace-installed plugins across the global and project roots.
 *
 * @param opts - the resolved dork home and the project root to scan.
 * @returns global plugins first, then project plugins; each sorted by name.
 */
export function scanInstalledPlugins(opts: {
  dorkHome: string;
  projectRoot: string;
}): InstalledPlugin[] {
  const globalPlugins = scanPluginsRoot(join(opts.dorkHome, 'plugins'), 'global');
  const projectPlugins = scanPluginsRoot(join(opts.projectRoot, '.dork', 'plugins'), 'project');
  return [...globalPlugins, ...projectPlugins];
}
