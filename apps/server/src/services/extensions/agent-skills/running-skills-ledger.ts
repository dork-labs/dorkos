/**
 * The running extensions' skills ledger, written by the server (DOR-2685, spec
 * `extension-agent-tools-and-skills` §7).
 *
 * After every change to which extensions run, {@link reconcileRunningSkills}
 * decides which extension skills agents should see and publishes the answer to
 * `{dorkHome}/extensions/running-skills.json`, the file Harness Sync reads
 * (`@dorkos/harness` `sources/running-extension-skills.ts`). The server and a
 * terminal `dorkos harness sync` then plan the same links, and stopping an
 * extension takes its skills away at the next projection.
 *
 * **Which skills.** Only those of an extension that is turned on, approved to
 * run (`mayRunExtensionCode`), valid and compatible, and the copy DorkOS runs
 * for its id; read from the folder that copy RUNS from (`runPath`, its verified
 * snapshot, when it has one), never the project folder beside it. A declared
 * skill whose `SKILL.md` is not there is left out. Skills are prompt content, so
 * they ride the same approval the extension's code does, and no other.
 *
 * **Global extensions** also get a generated Claude Code plugin root,
 * `{dorkHome}/cache/extensions/skill-plugins/<id>/`, which DorkOS's own Claude
 * Code sessions load (`ClaudeCodeRuntime.refreshActivatedPlugins`) and which
 * every global-tier link points through. It holds `.claude-plugin/plugin.json`
 * and one `skills/<name>` link per skill that passed the harness's own checks
 * (a real folder inside `skills/`, a parsing `SKILL.md`) — per skill rather than
 * one link to the whole folder, so a folder the extension did not declare, or a
 * link inside `skills/` pointing elsewhere, never reaches a session. The server
 * owns that folder whole: anything in it that is not a current root is removed.
 *
 * Writes happen only when something changed: the ledger is compared with the
 * file on disk, and each root with what it should hold.
 *
 * @module services/extensions/agent-skills/running-skills-ledger
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  RUNNING_EXTENSION_SKILLS_VERSION,
  extensionSkillPluginRoot,
  extensionSkillPluginsDir,
  globalExtensionSkillPackages,
  readRunningExtensionSkillsSync,
  runningExtensionSkillsPath,
  type RunningExtensionSkillsEntry,
  type RunningExtensionSkillsLedger,
} from '@dorkos/harness';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { isEnabled, type CoreExtensionInfo } from '../extension-enable-resolution.js';
import { mayRunExtensionCode } from '../extension-load-policy.js';
import { waitsForIsolation } from '../isolation/isolation-view.js';
import { writeFileAtomic } from '../extension-build-cache.js';
import type { ExtensionsConfig } from '../extension-enable-resolution.js';
import { logger } from '../../../lib/logger.js';

/** What the reconciler needs besides the records. */
export interface RunningSkillsContext {
  /** DorkOS's data directory. */
  dorkHome: string;
  /** The extensions section of config: what is on, and what may run. */
  config: ExtensionsConfig;
  /** Tier metadata for the bundled core extensions. */
  core: Map<string, CoreExtensionInfo>;
}

/** What one reconcile changed, for the caller to project. */
export interface RunningSkillsChange {
  /** Whether the ledger file was rewritten. */
  ledgerChanged: boolean;
  /**
   * Every project whose local extension skills changed, with whether any
   * remain there after the change: the old set's projects and the new set's,
   * so a project an extension just left is projected (and swept) too.
   */
  projects: Array<{ root: string; ids: string[]; remaining: boolean }>;
  /** Whether the global entries, or any generated plugin root, changed. */
  globalChanged: boolean;
}

/** Statuses a record can never project skills from. */
const NOT_RUNNING: ReadonlySet<ExtensionRecord['status']> = new Set([
  'invalid',
  'incompatible',
  'disabled',
]);

/**
 * The project a local copy belongs to, from where discovery found it.
 *
 * A local copy is either the project's own (`<root>/.dork/extensions/<id>`) or
 * carried by a plugin installed into the project
 * (`<root>/.dork/plugins/<p>/.dork/extensions/<id>`). Anything that does not
 * have exactly one of those shapes answers `undefined` and projects nothing:
 * guessing a project root is how a skill would end up somewhere nobody chose.
 *
 * @param record - A local copy.
 * @returns The project root, or `undefined`.
 */
export function projectRootOf(
  record: Pick<ExtensionRecord, 'path' | 'sourcePlugin'>
): string | undefined {
  const dir = path.resolve(record.path);
  const extensionsDir = path.dirname(dir);
  const dork = path.dirname(extensionsDir);
  if (path.basename(extensionsDir) !== 'extensions' || path.basename(dork) !== '.dork') {
    return undefined;
  }
  if (!record.sourcePlugin) return path.dirname(dork);
  const plugin = path.dirname(dork);
  const plugins = path.dirname(plugin);
  const projectDork = path.dirname(plugins);
  if (
    path.basename(plugin) !== record.sourcePlugin ||
    path.basename(plugins) !== 'plugins' ||
    path.basename(projectDork) !== '.dork'
  ) {
    return undefined;
  }
  return path.dirname(projectDork);
}

/** Whether `file` is a regular file (not a link, not a folder). */
async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * The ledger entries for the copies that run now, sorted by id.
 *
 * @param records - The copies the last scan chose (one per id).
 * @param ctx - Config and core metadata.
 * @returns One entry per running extension that ships at least one skill on disk.
 */
export async function selectRunningSkills(
  records: readonly ExtensionRecord[],
  ctx: Pick<RunningSkillsContext, 'config' | 'core'>
): Promise<RunningExtensionSkillsEntry[]> {
  const entries: RunningExtensionSkillsEntry[] = [];
  for (const record of records) {
    const declared = record.manifest.skills ?? [];
    if (declared.length === 0 || record.shadowedBy) continue;
    if (NOT_RUNNING.has(record.status)) continue;
    if (!isEnabled(record.id, ctx.config, ctx.core)) continue;
    // The coverage-aware gate: a copy whose manifest widened past its
    // approval waits for a person, and so do its skills (DOR-2686).
    if (!mayRunExtensionCode(record, ctx.config)) continue;
    // A copy that asks to run separately does not run yet, so its skills do
    // not reach agents either (DOR-2686 phase 1, `isolation_not_ready`).
    if (waitsForIsolation(record.manifest)) continue;
    // The folder the copy RUNS from: a trusted copy's verified snapshot, so a
    // project file changed after the scan never becomes a skill.
    const skillsDir = path.join(record.runPath ?? record.path, 'skills');
    const skills: string[] = [];
    for (const name of [...new Set(declared)].sort()) {
      if (await isRegularFile(path.join(skillsDir, name, 'SKILL.md'))) skills.push(name);
    }
    if (skills.length === 0) continue;
    const devLink = record.devLink ? { devLink: record.devLink.path } : {};
    if (record.scope === 'local') {
      const projectRoot = projectRootOf(record);
      if (projectRoot === undefined) continue;
      entries.push({ id: record.id, scope: 'local', projectRoot, skillsDir, skills, ...devLink });
    } else {
      entries.push({ id: record.id, scope: 'global', skillsDir, skills, ...devLink });
    }
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

/** The ledger file's exact bytes for these entries. */
function ledgerText(entries: readonly RunningExtensionSkillsEntry[]): string {
  const ledger: RunningExtensionSkillsLedger = {
    version: RUNNING_EXTENSION_SKILLS_VERSION,
    extensions: [...entries],
  };
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

/** The file's current bytes, or `null` when it is not there or cannot be read. */
async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch {
    return null;
  }
}

/** A stable key for one entry's local placement, for the before/after diff. */
function localKey(entry: RunningExtensionSkillsEntry): string {
  return JSON.stringify([entry.projectRoot, entry.skillsDir, entry.skills, entry.devLink ?? null]);
}

/**
 * Every project whose local extension skills differ between two ledgers.
 *
 * @param before - The entries the ledger held.
 * @param after - The entries it holds now.
 * @returns One record per affected project root, sorted.
 */
function changedProjects(
  before: readonly RunningExtensionSkillsEntry[],
  after: readonly RunningExtensionSkillsEntry[]
): RunningSkillsChange['projects'] {
  const local = (entries: readonly RunningExtensionSkillsEntry[]) =>
    new Map(entries.filter((e) => e.scope === 'local').map((e) => [e.id, e]));
  const was = local(before);
  const now = local(after);
  const byRoot = new Map<string, Set<string>>();
  const touch = (root: string | undefined, id: string): void => {
    if (root === undefined) return;
    byRoot.set(root, (byRoot.get(root) ?? new Set()).add(id));
  };
  for (const id of new Set([...was.keys(), ...now.keys()])) {
    const a = was.get(id);
    const b = now.get(id);
    if (a && b && localKey(a) === localKey(b)) continue;
    touch(a?.projectRoot, id);
    touch(b?.projectRoot, id);
  }
  return [...byRoot]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([root, ids]) => ({
      root,
      ids: [...ids].sort(),
      remaining: [...now.values()].some((e) => e.projectRoot === root),
    }));
}

/** The global entries as a comparable string. */
function globalKey(entries: readonly RunningExtensionSkillsEntry[]): string {
  return JSON.stringify(entries.filter((e) => e.scope === 'global'));
}

/** What one generated plugin root should hold. */
interface PluginRootSpec {
  id: string;
  pluginJson: string;
  /** Skill name to the real folder its link points at. */
  links: Map<string, string>;
}

/**
 * The plugin roots the global entries need, holding only skills that pass the
 * harness's own checks — the same function `dorkos harness sync --global`
 * plans from, so a session and a sync never disagree about a skill.
 */
function pluginRootSpecs(
  entries: readonly RunningExtensionSkillsEntry[],
  records: ReadonlyMap<string, ExtensionRecord>,
  dorkHome: string
): PluginRootSpec[] {
  const checked = globalExtensionSkillPackages({ state: 'read', entries: [...entries] }, dorkHome);
  return checked.packages.map((pkg) => ({
    id: pkg.name,
    pluginJson: `${JSON.stringify(
      { name: pkg.name, version: records.get(pkg.name)?.manifest.version ?? '0.0.0' },
      null,
      2
    )}\n`,
    links: new Map(pkg.skills.map((skill) => [skill.name, path.join(pkg.skillsDir, skill.name)])),
  }));
}

/** Whether a root on disk already holds exactly what `spec` says. */
async function rootMatches(root: string, spec: PluginRootSpec): Promise<boolean> {
  try {
    if (!(await fs.lstat(root)).isDirectory()) return false;
    const top = (await fs.readdir(root)).sort();
    if (JSON.stringify(top) !== JSON.stringify(['.claude-plugin', 'skills'])) return false;
    const manifest = path.join(root, '.claude-plugin', 'plugin.json');
    if (!(await isRegularFile(manifest))) return false;
    if ((await fs.readdir(path.join(root, '.claude-plugin'))).length !== 1) return false;
    if ((await fs.readFile(manifest, 'utf-8')) !== spec.pluginJson) return false;
    const skillsDir = path.join(root, 'skills');
    if (!(await fs.lstat(skillsDir)).isDirectory()) return false;
    const names = (await fs.readdir(skillsDir)).sort();
    if (JSON.stringify(names) !== JSON.stringify([...spec.links.keys()].sort())) return false;
    for (const [name, target] of spec.links) {
      const link = path.join(skillsDir, name);
      if (!(await fs.lstat(link)).isSymbolicLink()) return false;
      if ((await fs.readlink(link)) !== target) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Remove whatever is at `p` without following a link it may be. */
async function removeEntry(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

/**
 * Make sure the folder of plugin roots is the real folder DorkOS owns, before
 * anything is written into it OR listed and removed from it.
 *
 * Asked on every reconcile, including one with no roots to write: that is the
 * one that lists the folder and removes whatever is in it, and listing through
 * a link standing where the folder belongs would delete the contents of
 * wherever it points. A link (or a file) there is removed, never followed. A
 * folder whose real path is not `{dorkHome}/cache/extensions/skill-plugins` —
 * reached through a link higher up, at `cache/` or `cache/extensions/` — is
 * left alone, and the reconcile fails loudly instead.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param create - Whether to create the folder when it is not there.
 * @returns Whether the folder may be used, and whether anything was removed.
 */
async function prepareRootsDir(
  dorkHome: string,
  create: boolean
): Promise<{ usable: boolean; changed: boolean }> {
  const dir = extensionSkillPluginsDir(dorkHome);
  let changed = false;
  let stats = await fs.lstat(dir).catch(() => undefined);
  if (stats && !stats.isDirectory()) {
    await removeEntry(dir); // a link or a file: the entry goes, its target is untouched
    changed = true;
    stats = undefined;
  }
  if (!stats) {
    if (!create) return { usable: false, changed };
    await fs.mkdir(dir, { recursive: true });
  }
  const expected = path.join(await fs.realpath(dorkHome), 'cache', 'extensions', 'skill-plugins');
  if ((await fs.realpath(dir)) !== expected) {
    throw new Error(`${dir} is reached through a link to somewhere else, so DorkOS left it alone`);
  }
  return { usable: true, changed };
}

/**
 * Bring every generated plugin root in line with the global entries: write the
 * ones that are missing or differ (built beside, then renamed into place), and
 * remove everything else in the folder.
 *
 * @returns Whether anything on disk changed.
 */
async function syncPluginRoots(
  dorkHome: string,
  specs: readonly PluginRootSpec[]
): Promise<boolean> {
  const dir = extensionSkillPluginsDir(dorkHome);
  const prepared = await prepareRootsDir(dorkHome, specs.length > 0);
  if (!prepared.usable) return prepared.changed;
  let changed = prepared.changed;
  for (const spec of specs) {
    const root = extensionSkillPluginRoot(dorkHome, spec.id);
    if (await rootMatches(root, spec)) continue;
    const staging = path.join(dir, `.staging-${spec.id}-${randomBytes(4).toString('hex')}`);
    try {
      await fs.mkdir(path.join(staging, '.claude-plugin'), { recursive: true });
      await fs.writeFile(path.join(staging, '.claude-plugin', 'plugin.json'), spec.pluginJson);
      await fs.mkdir(path.join(staging, 'skills'));
      for (const [name, target] of spec.links) {
        // A junction on Windows: it needs no developer mode, and the target is
        // absolute, which is the one thing a junction requires.
        await fs.symlink(
          target,
          path.join(staging, 'skills', name),
          process.platform === 'win32' ? 'junction' : 'dir'
        );
      }
      await removeEntry(root);
      await fs.rename(staging, root);
      changed = true;
    } catch (err) {
      await removeEntry(staging);
      throw err;
    }
  }
  // Everything else here goes, a crash-left `.staging-*` included. This
  // assumes one server per data directory: reconciles are serialized within a
  // server, but two servers sharing one could remove each other's staging
  // folder mid-build, which fails that reconcile (logged) and loses nothing.
  const wanted = new Set(specs.map((spec) => spec.id));
  const present = await fs.readdir(dir).catch((): string[] => []);
  for (const name of present) {
    if (wanted.has(name)) continue;
    await removeEntry(path.join(dir, name));
    changed = true;
  }
  return changed;
}

/**
 * Publish which extension skills agents should see, and keep the generated
 * plugin roots in step.
 *
 * Order matters for a terminal sync running at the same moment: the roots are
 * written BEFORE the ledger names them, so a sync that reads the new ledger
 * finds its roots in place. Removing a root that is no longer wanted can only
 * make a stale link dangle, which is the withdrawal it exists for.
 *
 * @param records - The copies the last scan chose.
 * @param ctx - Data directory, config and core metadata.
 * @returns What changed, for the caller to project.
 */
export async function reconcileRunningSkills(
  records: readonly ExtensionRecord[],
  ctx: RunningSkillsContext
): Promise<RunningSkillsChange> {
  const file = runningExtensionSkillsPath(ctx.dorkHome);
  const before = readRunningExtensionSkillsSync(ctx.dorkHome).entries;
  const after = await selectRunningSkills(records, ctx);
  const byId = new Map(records.map((record) => [record.id, record]));

  const rootsChanged = await syncPluginRoots(
    ctx.dorkHome,
    pluginRootSpecs(
      after.filter((entry) => entry.scope === 'global'),
      byId,
      ctx.dorkHome
    )
  );

  const text = ledgerText(after);
  const ledgerChanged = (await readText(file)) !== text;
  if (ledgerChanged) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, text);
    logger.info('[Extensions] Published the running extensions’ skills', {
      extensions: after.map((entry) => `${entry.id} (${entry.skills.length})`),
    });
  }

  return {
    ledgerChanged,
    projects: changedProjects(before, after),
    globalChanged: rootsChanged || globalKey(before) !== globalKey(after),
  };
}

/**
 * The generated plugin roots DorkOS's Claude Code sessions should load: one per
 * global extension the ledger lists, when its root is in place.
 *
 * Read from the ledger rather than from live server state, so it answers the
 * same question the global sync does. A root that is missing or is not a real
 * folder is left out. So is an extension whose id is the name of a global
 * plugin the session already loads: Claude Code names a plugin's skills by the
 * plugin's name, so two plugins of one name would collide, and the plugin wins,
 * as it does everywhere else. Never throws; a ledger it cannot read loads none.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param loadedPluginNames - Names of the global plugins sessions already load.
 * @returns Absolute plugin root paths, sorted by extension id.
 */
export async function extensionSkillPluginRoots(
  dorkHome: string,
  loadedPluginNames: ReadonlySet<string> = new Set()
): Promise<string[]> {
  const roots: string[] = [];
  for (const entry of readRunningExtensionSkillsSync(dorkHome).entries) {
    if (entry.scope !== 'global') continue;
    if (loadedPluginNames.has(entry.id)) {
      logger.info(
        `[Extensions] Left the "${entry.id}" extension's skills out of Claude Code sessions: a plugin of the same name is loaded, and the plugin wins`
      );
      continue;
    }
    const root = extensionSkillPluginRoot(dorkHome, entry.id);
    try {
      if (!(await fs.lstat(root)).isDirectory()) continue;
      if (!(await isRegularFile(path.join(root, '.claude-plugin', 'plugin.json')))) continue;
    } catch {
      continue;
    }
    roots.push(root);
  }
  return roots;
}
