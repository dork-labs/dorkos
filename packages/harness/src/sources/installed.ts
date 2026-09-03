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
 * and tasks (`.dork/tasks/<name>/`, both `SKILL.md` directories), its slash
 * commands (`commands/*.md`), and its Claude-plugin hooks (`hooks/hooks.json`).
 * Everything else (extensions, adapters, mcp-servers, …) has no harness home and
 * is dropped by the projector.
 *
 * @module sources/installed
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MarketplacePackageManifestSchema, PackageNameSchema } from '@dorkos/marketplace';
import { hasSchedule, isInvalidSchedule, readScheduleField } from '@dorkos/skills/schedule-schema';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { scanSkillDirs, CLAUDE_PLUGIN_ROOT_TOKEN, type SkillEntry } from '../scan/scanner.js';
import { emptyHooksConfig } from '../generate/hooks.js';
import type { ClaudeHooksConfig, HookCommand, HookMatcherGroup } from '../generate/hooks.js';

/** Where an installed plugin lives — its install scope. */
export type InstalledScope = 'global' | 'project';

/** A portable skill from an installed plugin, plus whether it needs plugin context. */
export interface InstalledSkill extends SkillEntry {
  /**
   * True when the skill's `SKILL.md` references `${CLAUDE_PLUGIN_ROOT}`. That
   * token only resolves inside plugin (SDK-activation) context, so a projected
   * copy read directly off disk will not expand it; the projector surfaces this
   * as a {@link ProjectionWarning}.
   */
  usesPluginRoot: boolean;
  /**
   * The skill's `SKILL.md` frontmatter `name`, when present. Claude Code keys a
   * skill by its DIRECTORY name (so the `<pkg>__<name>` projection namespacing
   * protects it), but OpenCode and Codex key a skill by this FRONTMATTER name, so
   * two skills sharing a frontmatter name collide there regardless of the
   * directory namespacing. The projector reads this to warn on such collisions.
   */
  frontmatterName?: string;
  /**
   * True when the skill's `SKILL.md` declares a `schedule:` block — readable or
   * not.
   *
   * This is what makes a skill a scheduled task, and it changes where the skill
   * has to be projected: the DorkOS scheduler watches `.agents/skills`, never
   * `.claude/skills`, so a schedule-bearing skill that only reached the Claude
   * Code dir would never be offered for approval (DOR-1518). The projector reads
   * this to link such a skill into `.agents/skills` whatever harnesses the
   * project enables.
   *
   * An UNREADABLE block counts too: discovery turns it into a parked row
   * carrying the complaint, which is only possible if the file is reachable
   * from a watched root at all.
   */
  hasSchedule: boolean;
}

/** A portable slash command (`commands/<name>.md`) from an installed plugin. */
export interface InstalledCommand {
  /** Command name: the file basename without `.md`, the `/<pkg>:<name>` leaf. */
  name: string;
  /** Repo-relative source path, e.g. `.dork/plugins/<pkg>/commands/<name>.md`. */
  sourcePath: string;
  /** Raw bytes of the source command markdown (used to build the wrapper). */
  content: string;
}

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
  skills: InstalledSkill[];
  /**
   * Top-level slash-command files (`commands/*.md`). Empty for global plugins.
   * Projected to the Claude Code harness as repo-local wrappers (DOR-193).
   */
  commands: InstalledCommand[];
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

/**
 * Read + validate a plugin's identity: `.dork/manifest.json` first, falling
 * back to the Claude Code plugin manifest (`.claude-plugin/plugin.json`) for
 * CC-native packages installed without a DorkOS manifest — the marketplace
 * installer copies such packages verbatim, so nothing on disk ever gains a
 * `.dork/manifest.json`. Without this fallback every CC-native plugin was
 * invisible to projection and Harness Sync silently applied zero files
 * (DOR-264). Returns `undefined` when neither manifest is present or valid.
 */
function readPluginManifest(pluginDir: string): PluginIdentity | undefined {
  const manifestPath = join(pluginDir, '.dork', 'manifest.json');
  if (!existsSync(manifestPath)) return readCcPluginManifest(pluginDir);
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

/**
 * Derive a {@link PluginIdentity} from a Claude Code plugin manifest
 * (`.claude-plugin/plugin.json`). Mirrors the marketplace validator's
 * CC-manifest synthesis: a CC plugin maps to `type: 'plugin'` with no
 * declared layers. Only the `name` is required, and it must pass the same
 * kebab-case {@link PackageNameSchema} a synthesized `.dork/manifest.json`
 * would — the projector interpolates it into filesystem paths, and `dorkos
 * harness sync` scans `.dork/plugins/` independently of install-time
 * validation, so an arbitrary string must never get through. Anything
 * unreadable, nameless, or slug-invalid is skipped (`undefined`).
 */
function readCcPluginManifest(pluginDir: string): PluginIdentity | undefined {
  const ccManifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
  if (!existsSync(ccManifestPath)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(ccManifestPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object') return undefined;
  const name = PackageNameSchema.safeParse((raw as { name?: unknown }).name);
  if (!name.success) return undefined;
  return { name: name.data, type: 'plugin', layers: [] };
}

/**
 * Validate one matcher group's INTERIOR, keeping every hook command that names a
 * real shell command and dropping the rest.
 *
 * Checking only that an event's value is an array left the group interior cast
 * straight through, so a group that was `null`, carried no `hooks` array, or
 * held a command whose `command` was not a string reached the projector and
 * crashed it (`TypeError: group.hooks.map is not a function`) — one sloppy
 * package took down `dorkos harness sync` for every other package (DOR-646).
 *
 * The keep rule is deliberately the one the marketplace permission preview
 * already applies (`services/marketplace/permission-preview.ts`): a command
 * counts when it is an object whose `command` is a non-empty string, and a
 * `matcher` counts when it is a non-empty string. The preview's whole promise is
 * that it describes what the projector will do, so the two must salvage exactly
 * the same commands from the same bad file.
 *
 * Fields neither side interprets ride through untouched — `timeout` is a real
 * Claude Code hook field, and dropping what this reader does not recognize would
 * quietly change working hooks. A missing or non-string `type` becomes
 * `'command'`, the only kind Claude Code has, so a salvaged command is written
 * out as a valid hook rather than an invalid one.
 *
 * @returns the validated group, or `undefined` when nothing in it is usable.
 */
function readMatcherGroup(group: unknown): HookMatcherGroup | undefined {
  if (!group || typeof group !== 'object') return undefined;
  const {
    matcher,
    hooks: commands,
    ...rest
  } = group as { matcher?: unknown; hooks?: unknown } & Record<string, unknown>;
  if (!Array.isArray(commands)) return undefined;

  const validated: HookCommand[] = [];
  for (const entry of commands) {
    if (!entry || typeof entry !== 'object') continue;
    const { command, type, ...commandRest } = entry as {
      command?: unknown;
      type?: unknown;
    } & Record<string, unknown>;
    if (typeof command !== 'string' || command.length === 0) continue;
    validated.push({
      ...commandRest,
      type: typeof type === 'string' && type.length > 0 ? type : 'command',
      command,
    });
  }
  if (validated.length === 0) return undefined;

  return {
    ...rest,
    ...(typeof matcher === 'string' && matcher.length > 0 ? { matcher } : {}),
    hooks: validated,
  };
}

/**
 * Read a plugin's Claude-plugin hooks (`hooks/hooks.json`), tolerating either
 * shape and validating every event value and the matcher groups inside it.
 *
 * Only event keys whose value is an ARRAY of matcher groups are kept — a
 * malformed entry (e.g. `{"Stop": {…}}` instead of `{"Stop": [{…}]}`) would
 * otherwise survive the cast and crash the hook merge's `[...groups]` spread with
 * `TypeError: groups is not iterable`. Each group is then validated by
 * {@link readMatcherGroup}. Bad groups are dropped, not their readable siblings
 * and not the whole file: `{"Stop": [{hooks: [{command: 'good.sh'}]}, {hooks: 'nope'}]}`
 * still projects `good.sh`. An event left with no usable group is dropped
 * entirely rather than kept as an empty array, so a package that declares only
 * unreadable hooks contributes no hooks at all.
 *
 * The event names are PACKAGE-CHOSEN strings, so the result is built on a
 * null-prototype object ({@link emptyHooksConfig}): assigning a key named
 * `__proto__` to a `{}` literal hits `Object.prototype`'s inherited setter
 * instead of creating a property, which would swallow that event's groups
 * silently — the preview would disclose a command the projector then dropped,
 * which is the exact disagreement this reader exists to end.
 */
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
  const hooksObj =
    raw && typeof raw === 'object' && 'hooks' in raw ? (raw as { hooks: unknown }).hooks : raw;
  if (!hooksObj || typeof hooksObj !== 'object') return undefined;

  const validated = emptyHooksConfig();
  for (const [event, groups] of Object.entries(hooksObj as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    const usable = groups
      .map(readMatcherGroup)
      .filter((group): group is HookMatcherGroup => group !== undefined);
    if (usable.length > 0) validated[event] = usable;
  }
  return Object.keys(validated).length > 0 ? validated : undefined;
}

/**
 * Whether a `SKILL.md`'s frontmatter declares a `schedule:` block, readable or
 * not.
 *
 * Asked through the skills package's own {@link readScheduleField}, so this
 * answers exactly the question `skills-root-discovery.ts` will later ask of the
 * same bytes. A hand-rolled `^schedule:` match could disagree with the scheduler
 * about what a file is, and a schedule that silently does not exist because a
 * scanner misread frontmatter is the worst outcome the design has (ADR
 * `specs/universal-scheduled-tasks` §DD2).
 *
 * A block DorkOS cannot read still counts. Discovery parks such a file as a row
 * carrying the complaint rather than dropping it, and it can only do that if the
 * file reached a watched root — so an unreadable block must still be projected.
 */
function declaresSchedule(frontmatter: Record<string, unknown>): boolean {
  const schedule = readScheduleField(frontmatter.schedule);
  return hasSchedule({ schedule }) || isInvalidSchedule(schedule);
}

/**
 * Enrich a scanned skill entry from its `SKILL.md` (read and parsed once): the
 * `${CLAUDE_PLUGIN_ROOT}` usage flag, the frontmatter `name` (the effective
 * identity in frontmatter-keyed harnesses), and whether it carries a schedule.
 *
 * A non-string frontmatter `name` (e.g. `name: 12`) is treated as absent: the
 * field exists only to compare against other skills' names, and a non-string
 * there is not one.
 */
function toInstalledSkill(entry: SkillEntry, absSkillsRoot: string): InstalledSkill {
  let skillMd = '';
  try {
    skillMd = readFileSync(join(absSkillsRoot, entry.name, 'SKILL.md'), 'utf8');
  } catch {
    // No readable SKILL.md — the empty default above stands.
  }
  const frontmatter = readRawFrontmatter(skillMd)?.data ?? {};
  return {
    ...entry,
    usesPluginRoot: skillMd.includes(CLAUDE_PLUGIN_ROOT_TOKEN),
    ...(typeof frontmatter.name === 'string' ? { frontmatterName: frontmatter.name } : {}),
    hasSchedule: declaresSchedule(frontmatter),
  };
}

/** Collect a project plugin's portable skill dirs (skills/ + .dork/tasks/), de-duped by name. */
function collectPortableSkills(pluginDir: string, relDir: string): InstalledSkill[] {
  const skillsRoot = join(pluginDir, 'skills');
  const tasksRoot = join(pluginDir, '.dork', 'tasks');
  const skillEntries = scanSkillDirs(skillsRoot, `${relDir}/skills`).map((e) =>
    toInstalledSkill(e, skillsRoot)
  );
  const taskEntries = scanSkillDirs(tasksRoot, `${relDir}/.dork/tasks`).map((e) =>
    toInstalledSkill(e, tasksRoot)
  );
  const byName = new Map<string, InstalledSkill>();
  for (const entry of [...skillEntries, ...taskEntries]) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry); // skills win over same-named tasks
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Collect a project plugin's top-level slash commands (`commands/*.md`).
 *
 * Only the top level is enumerated: Claude Code derives a command's namespace
 * from its immediate parent directory, and a plugin's commands live flat under
 * `commands/`. Each file's raw bytes are read so the projector can rewrite the
 * `${CLAUDE_PLUGIN_ROOT}` token and emit a repo-local wrapper. Sorted by name so
 * the projection plan is deterministic.
 */
function collectCommands(pluginDir: string, relDir: string): InstalledCommand[] {
  const commandsRoot = join(pluginDir, 'commands');
  if (!existsSync(commandsRoot)) return [];
  const commands: InstalledCommand[] = [];
  for (const entry of readdirSync(commandsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    let content: string;
    try {
      content = readFileSync(join(commandsRoot, entry.name), 'utf8');
    } catch {
      continue;
    }
    commands.push({
      name: entry.name.slice(0, -'.md'.length),
      sourcePath: `${relDir}/commands/${entry.name}`,
      content,
    });
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
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
      //
      // KNOWN GAP (DOR-1518): this is also why a schedule-bearing skill in a
      // GLOBALLY installed plugin (`<dorkHome>/plugins/<pkg>`) stays invisible to
      // the scheduler. The scheduler's global watched root is `<dorkHome>/skills`,
      // and no projection stage targets it — `buildPlan` is repo-relative end to
      // end, and every apply/sweep path resolves against a `repoRoot`. The
      // project-scope fix below (`planScheduledSkillLinks`) therefore has no
      // global twin; giving it one means building a global sync first, not
      // widening this scan.
      plugins.push({
        name: manifest.name,
        type: manifest.type,
        scope,
        skills: [],
        commands: [],
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
      commands: collectCommands(pluginDir, relDir),
      hooks: readPluginHooks(pluginDir),
      layers: manifest.layers,
    });
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Discover all marketplace-installed plugins across the global and project roots.
 *
 * Project-scoped plugins live at `<projectRoot>/.dork/plugins/<name>` and are
 * always scanned — they are repo-relative and need no dork home. The global
 * scope (`<dorkHome>/plugins`) is only scanned when `dorkHome` is provided; an
 * offline `dorkos harness sync` (no `~/.dork`) thus still projects a repo's own
 * project-scoped installs.
 *
 * @param opts - the project root to scan and, optionally, a resolved dork home.
 * @returns global plugins first (only when `dorkHome` is given), then project
 *   plugins; each group sorted by name.
 */
export function scanInstalledPlugins(opts: {
  dorkHome?: string;
  projectRoot: string;
}): InstalledPlugin[] {
  const globalPlugins = opts.dorkHome
    ? scanPluginsRoot(join(opts.dorkHome, 'plugins'), 'global')
    : [];
  const projectPlugins = scanPluginsRoot(join(opts.projectRoot, '.dork', 'plugins'), 'project');
  return [...globalPlugins, ...projectPlugins];
}
