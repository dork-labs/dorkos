/**
 * Running extensions' skills — the ledger the server publishes and every sync
 * reads (DOR-2685, spec `extension-agent-tools-and-skills` §7).
 *
 * An extension may ship skills (`<extension>/skills/<name>/SKILL.md`). They
 * reach agents exactly as a plugin's skills at the same scope (ADR
 * 260706-192819), but only while the extension runs: enabled, approved to run,
 * valid, and the copy DorkOS chose for its id. Only the server knows that, and
 * `dorkos harness sync` from a terminal runs without the server, so the server
 * writes what it decided to `{dorkHome}/extensions/running-skills.json` and
 * both read the same file. That is what makes a terminal sync plan exactly what
 * the server plans, and what keeps its orphan sweep from deleting a running
 * extension's skills.
 *
 * The file is DERIVED: the server rewrites it after every scan, and deleting it
 * is safe. It is still read as untrusted input, because a sync turns what it
 * names into links agents read: every path is checked against where an
 * extension can actually live, every skill folder must be a real folder inside
 * its `skills/` (no symbolic links, no `..`), and every `SKILL.md` must parse.
 *
 * Extension skills travel BESIDE the installed plugins, never inside
 * `InstalledSourceScan.plugins`: every reader of that list (hook consent, the
 * global-install drops, the status page's package list, unreadable manifests)
 * is about marketplace packages, and an extension is not one. They join the
 * plans through their own input, {@link ExtensionSkillPackage}.
 *
 * @module sources/running-extension-skills
 */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { EXTENSION_ID_REGEX } from '@dorkos/shared/extension-id';
import { PACKAGE_TEXT_MAX_BYTES, readTextFileWithinSync } from '@dorkos/shared/bounded-read';
import { validateSlug } from '@dorkos/skills/slug';
import { parseSkillFile, readRawFrontmatter } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { hasSchedule, isInvalidSchedule, readScheduleField } from '@dorkos/skills/schedule-schema';
import type { HarnessId } from '../manifest/schema.js';
import type { ProjectionWarning } from '../plan/types.js';
import { CLAUDE_PLUGIN_DATA_TOKEN, CLAUDE_PLUGIN_ROOT_TOKEN } from '../scan/scanner.js';
import type { InstalledSkill } from './installed.js';

/** The ledger's file name, inside `{dorkHome}/extensions/`. */
export const RUNNING_EXTENSION_SKILLS_FILE = 'running-skills.json';

/** The ledger format this engine reads and the server writes. */
export const RUNNING_EXTENSION_SKILLS_VERSION = 1;

/**
 * Where the ledger lives.
 *
 * @param dorkHome - the DorkOS data directory, absolute.
 * @returns `{dorkHome}/extensions/running-skills.json`.
 */
export function runningExtensionSkillsPath(dorkHome: string): string {
  return join(dorkHome, 'extensions', RUNNING_EXTENSION_SKILLS_FILE);
}

/**
 * The folder holding one generated plugin root per running global extension
 * with skills: `{dorkHome}/cache/extensions/skill-plugins`.
 *
 * The server owns it whole. Each `<id>/` inside is a Claude Code plugin root
 * (`.claude-plugin/plugin.json` plus `skills/<name>` links to the extension's
 * validated skill folders) that DorkOS's own Claude Code sessions load, and it
 * is what every global-tier link points through, so removing a root withdraws
 * that extension's skills everywhere at once.
 *
 * @param dorkHome - the DorkOS data directory, absolute.
 * @returns the absolute folder.
 */
export function extensionSkillPluginsDir(dorkHome: string): string {
  return join(dorkHome, 'cache', 'extensions', 'skill-plugins');
}

/**
 * The generated plugin root for one global extension.
 *
 * @param dorkHome - the DorkOS data directory, absolute.
 * @param id - the extension id (already checked against {@link EXTENSION_ID_REGEX}).
 * @returns `{dorkHome}/cache/extensions/skill-plugins/<id>`.
 */
export function extensionSkillPluginRoot(dorkHome: string, id: string): string {
  return join(extensionSkillPluginsDir(dorkHome), id);
}

/** An absolute path, the only kind the ledger stores. */
const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value), 'Must be an absolute path');

/** One running extension that ships skills. */
export const RunningExtensionSkillsEntrySchema = z
  .object({
    /** The extension id; also the projection namespace (`<id>__<skill>`). */
    id: z.string().regex(EXTENSION_ID_REGEX),
    /** Where its skills reach: one project (`local`) or every project (`global`). */
    scope: z.enum(['global', 'local']),
    /** The project a `local` extension belongs to. Absent for `global`. */
    projectRoot: AbsolutePathSchema.optional(),
    /** The running copy's `skills/` folder (its verified snapshot when it has one). */
    skillsDir: AbsolutePathSchema,
    /** Declared skills whose `SKILL.md` was there when the server wrote this. */
    skills: z.array(z.string().refine(validateSlug)),
    /** The folder a dev-linked copy runs from (DOR-2696), when it is one. */
    devLink: AbsolutePathSchema.optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.scope === 'local' && entry.projectRoot === undefined) {
      ctx.addIssue({ code: 'custom', message: 'A local entry names its project' });
    }
    if (entry.scope === 'global' && entry.projectRoot !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'A global entry names no project' });
    }
    if (new Set(entry.skills).size !== entry.skills.length) {
      ctx.addIssue({ code: 'custom', message: 'Each skill is listed once' });
    }
  });

/** One running extension that ships skills. */
export type RunningExtensionSkillsEntry = z.infer<typeof RunningExtensionSkillsEntrySchema>;

/** The whole ledger. */
export const RunningExtensionSkillsLedgerSchema = z
  .object({
    version: z.literal(RUNNING_EXTENSION_SKILLS_VERSION),
    extensions: z.array(RunningExtensionSkillsEntrySchema),
  })
  .superRefine((ledger, ctx) => {
    const ids = ledger.extensions.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: 'Each extension is listed once' });
    }
  });

/** The whole ledger. */
export type RunningExtensionSkillsLedger = z.infer<typeof RunningExtensionSkillsLedgerSchema>;

/**
 * What a read of the ledger found.
 *
 * Three states, because the sweeps treat them differently: `read` is
 * authoritative (an extension it does not name is not running), `absent` means
 * the server has not written it (nothing is running, or it was deleted and the
 * next scan rewrites it), and `unreadable` is evidence of nothing — the global
 * sweep then keeps every extension link whose plugin root is still there.
 */
export interface RunningExtensionSkills {
  /** Whether the file was there and parsed. */
  state: 'read' | 'absent' | 'unreadable';
  /** The entries, sorted by id. Empty unless `state` is `read`. */
  entries: RunningExtensionSkillsEntry[];
  /** Why it could not be read, when `state` is `unreadable`. */
  reason?: string;
}

/**
 * Read the ledger. Never throws: an absent file is an empty ledger, and one
 * that will not read or parse is an empty ledger that says why.
 *
 * @param dorkHome - the DorkOS data directory, absolute; `undefined` (an offline
 *   sync) reads nothing.
 * @returns what the file says.
 */
export function readRunningExtensionSkillsSync(
  dorkHome: string | undefined
): RunningExtensionSkills {
  if (dorkHome === undefined) return { state: 'absent', entries: [] };
  const file = runningExtensionSkillsPath(dorkHome);
  if (lstatSync(file, { throwIfNoEntry: false }) === undefined) {
    return { state: 'absent', entries: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readTextFileWithinSync(file, PACKAGE_TEXT_MAX_BYTES, 'The skills ledger'));
  } catch (err) {
    return { state: 'unreadable', entries: [], reason: messageOf(err) };
  }
  const parsed = RunningExtensionSkillsLedgerSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      state: 'unreadable',
      entries: [],
      reason: parsed.error.issues[0]?.message ?? 'invalid',
    };
  }
  return {
    state: 'read',
    entries: [...parsed.data.extensions].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/**
 * One running extension's skills, ready for a plan: the extension id as the
 * package name, and only skills (an extension projects no commands, hooks or
 * tasks).
 *
 * Every `sourceDir` is ABSOLUTE at both scopes. A local extension's running
 * copy can live outside the repository (a trusted copy runs from its verified
 * snapshot under `{dorkHome}/extension-snapshots/`), so a repo-relative path is
 * not always possible, and one spelling for both keeps every reader honest.
 */
export interface ExtensionSkillPackage {
  /** Always `extension`: what tells a reader this is not a marketplace package. */
  kind: 'extension';
  /** The extension id, used as the projection namespace. */
  name: string;
  /** The scope the ledger gave it. */
  scope: 'global' | 'local';
  /** The running copy's `skills/` folder, absolute. */
  skillsDir: string;
  /** Each skill that passed every check, sorted by name. */
  skills: InstalledSkill[];
  /** Set when the copy runs from a dev link: the folder it runs from. */
  devLink?: { path: string };
}

/** What reading the ledger's entries for one plan produced. */
export interface ExtensionSkillScan {
  /** The packages to plan. */
  packages: ExtensionSkillPackage[];
  /** One warning per skill that was dropped, and one for an unreadable ledger. */
  warnings: ProjectionWarning[];
}

/**
 * The harness a warning about an extension skill is attributed to: a
 * placeholder, with `harnessAgnostic` saying so, because a skill that was
 * dropped reaches no harness at all.
 */
const EXTENSION_WARNING_ATTRIBUTION: HarnessId = 'claude-code';

/**
 * Whether `child` is `root` or inside it, one path segment at a time (a bare
 * `startsWith` would accept `<root>-other`).
 */
function isInside(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** A thrown value as one line. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether a `SKILL.md`'s frontmatter declares a `schedule:` block, readable or
 * not — the question the installed-plugin scan asks of the same bytes, so a
 * timed extension skill is linked where the scheduler looks.
 */
function declaresSchedule(frontmatter: Record<string, unknown>): boolean {
  const schedule = readScheduleField(frontmatter.schedule);
  return hasSchedule({ schedule }) || isInvalidSchedule(schedule);
}

/**
 * Why a declared skill was left out, as a code a surface can word for a person
 * (Settings → Extensions says it without the absolute paths `reason` carries).
 *
 * - `invalid-name`: the name is not a SKILL.md slug.
 * - `missing-folder`: `skills/<name>` is not there.
 * - `not-a-folder`: it is a link, a file, or resolves outside `skills/`.
 * - `missing-file`: its `SKILL.md` is not there, or is not a regular file.
 * - `unreadable`: the folder or its `SKILL.md` could not be read.
 * - `invalid-file`: its `SKILL.md` does not parse as a skill.
 */
export type ExtensionSkillDropCode =
  | 'invalid-name'
  | 'missing-folder'
  | 'not-a-folder'
  | 'missing-file'
  | 'unreadable'
  | 'invalid-file';

/** One checked skill, or why it was refused. */
type SkillCheck =
  { ok: true; skill: InstalledSkill } | { ok: false; code: ExtensionSkillDropCode; reason: string };

/** Whether a declared extension skill can be projected, and if not, why not. */
export type ExtensionSkillFolderCheck =
  { ok: true } | { ok: false; code: ExtensionSkillDropCode; reason: string };

/**
 * Check one skill an extension declares against its `skills/` folder, by the
 * same rules a projection applies (DOR-2685). The server runs it at discovery
 * so Settings can say which skill is left out and why before any harness sync.
 *
 * @param skillsDir - the extension's `skills/` folder, absolute.
 * @param name - the declared skill name.
 * @returns ok, or the code and the full reason it is dropped.
 */
export function checkExtensionSkillFolder(
  skillsDir: string,
  name: string
): ExtensionSkillFolderCheck {
  const checked = checkExtensionSkill(skillsDir, name, join(skillsDir, name));
  return checked.ok ? { ok: true } : { ok: false, code: checked.code, reason: checked.reason };
}

/**
 * Check one declared skill of a running extension and describe it.
 *
 * The containment rules are the installed-plugin scan's, made explicit because
 * the folder a ledger names is not one a plugin install staged:
 *
 * - the name is a SKILL.md slug, so it cannot be `..`, absolute, or hold a
 *   separator;
 * - `<skillsDir>/<name>` is a real folder, never a symbolic link, and its real
 *   path is inside the real path of `<skillsDir>`;
 * - its `SKILL.md` is a regular file (not a link) under the size cap, and it
 *   parses with `@dorkos/skills`, with a frontmatter `name` matching the folder.
 *
 * @param skillsDir - the running copy's `skills/` folder, absolute.
 * @param name - the declared skill name.
 * @param sourceDir - the path the projection will point at.
 * @returns the skill, or the reason it is dropped.
 */
function checkExtensionSkill(skillsDir: string, name: string, sourceDir: string): SkillCheck {
  if (!validateSlug(name))
    return { ok: false, code: 'invalid-name', reason: 'its name is not a valid skill name' };
  const dir = join(skillsDir, name);
  const stats = lstatSync(dir, { throwIfNoEntry: false });
  if (stats === undefined)
    return { ok: false, code: 'missing-folder', reason: `${dir} is not there` };
  if (stats.isSymbolicLink())
    return { ok: false, code: 'not-a-folder', reason: `${dir} is a link, not a folder` };
  if (!stats.isDirectory())
    return { ok: false, code: 'not-a-folder', reason: `${dir} is not a folder` };
  let realRoot: string;
  let realDir: string;
  try {
    realRoot = realpathSync(skillsDir);
    realDir = realpathSync(dir);
  } catch (err) {
    return {
      ok: false,
      code: 'unreadable',
      reason: `${dir} could not be read (${messageOf(err)})`,
    };
  }
  if (!isInside(realDir, realRoot) || realDir === realRoot) {
    return {
      ok: false,
      code: 'not-a-folder',
      reason: `${dir} is outside the extension's skills folder`,
    };
  }
  const file = join(dir, 'SKILL.md');
  const fileStats = lstatSync(file, { throwIfNoEntry: false });
  if (fileStats === undefined)
    return { ok: false, code: 'missing-file', reason: `${file} is not there` };
  if (!fileStats.isFile())
    return { ok: false, code: 'missing-file', reason: `${file} is not a regular file` };
  let content: string;
  try {
    content = readTextFileWithinSync(file, PACKAGE_TEXT_MAX_BYTES, 'The SKILL.md');
  } catch (err) {
    return {
      ok: false,
      code: 'unreadable',
      reason: `${file} could not be read (${messageOf(err)})`,
    };
  }
  const parsed = parseSkillFile(file, content, SkillFrontmatterSchema);
  if (!parsed.ok) {
    return {
      ok: false,
      code: 'invalid-file',
      reason: `${file} is not a valid skill: ${parsed.error}`,
    };
  }
  const frontmatter = readRawFrontmatter(content)?.data ?? {};
  return {
    ok: true,
    skill: {
      name,
      sourceDir,
      usesPluginRoot: content.includes(CLAUDE_PLUGIN_ROOT_TOKEN),
      usesPluginData: content.includes(CLAUDE_PLUGIN_DATA_TOKEN),
      ...(typeof frontmatter.name === 'string' ? { frontmatterName: frontmatter.name } : {}),
      hasSchedule: declaresSchedule(frontmatter),
    },
  };
}

/**
 * Whether an entry's `skillsDir` is the `skills/` folder of that extension's own
 * folder: `…/extensions/<id>/skills` lexically (true of every place an
 * extension lives: `{dorkHome}/extensions/<id>`, a plugin's or a project's
 * `.dork/extensions/<id>`, and a verified snapshot of one), and still inside
 * that folder once links are resolved, so a `skills` link out of the extension
 * never becomes a source.
 */
function isOwnSkillsFolder(entry: RunningExtensionSkillsEntry): boolean {
  const skillsDir = resolve(entry.skillsDir);
  const extensionDir = dirname(skillsDir);
  if (
    basename(skillsDir) !== 'skills' ||
    basename(extensionDir) !== entry.id ||
    basename(dirname(extensionDir)) !== 'extensions'
  ) {
    return false;
  }
  try {
    const real = realpathSync(skillsDir);
    const realExtension = realpathSync(extensionDir);
    return real !== realExtension && isInside(real, realExtension);
  } catch {
    return false;
  }
}

/**
 * Turn ledger entries into packages, checking each skill.
 *
 * @param entries - the entries to read, already narrowed to one plan's scope.
 * @param sourceOf - where the projection of one skill points.
 * @returns the packages and one warning per dropped skill.
 */
function toPackages(
  entries: readonly RunningExtensionSkillsEntry[],
  sourceOf: (entry: RunningExtensionSkillsEntry, skill: string) => string
): ExtensionSkillScan {
  const packages: ExtensionSkillPackage[] = [];
  const warnings: ProjectionWarning[] = [];
  for (const entry of entries) {
    // A skills folder that is gone contributes nothing, so the next sweep
    // removes its links: the extension stopped, or its files went.
    if (lstatSync(entry.skillsDir, { throwIfNoEntry: false }) === undefined) continue;
    if (!isOwnSkillsFolder(entry)) continue;
    const skills: InstalledSkill[] = [];
    for (const name of [...entry.skills].sort()) {
      const checked = checkExtensionSkill(entry.skillsDir, name, sourceOf(entry, name));
      if (checked.ok) {
        skills.push(checked.skill);
        continue;
      }
      warnings.push({
        artifact: 'skill',
        harness: EXTENSION_WARNING_ATTRIBUTION,
        harnessAgnostic: true,
        name: `${entry.id}__${name}`,
        reason: `the "${entry.id}" extension's skill "${name}" was left out: ${checked.reason}`,
      });
    }
    if (skills.length === 0) continue;
    packages.push({
      kind: 'extension',
      name: entry.id,
      scope: entry.scope,
      skillsDir: entry.skillsDir,
      skills,
      ...(entry.devLink !== undefined ? { devLink: { path: entry.devLink } } : {}),
    });
  }
  return { packages, warnings };
}

/** The one warning an unreadable ledger earns. */
function unreadableLedgerWarning(dorkHome: string, reason: string): ProjectionWarning {
  return {
    artifact: 'skill',
    harness: EXTENSION_WARNING_ATTRIBUTION,
    harnessAgnostic: true,
    name: runningExtensionSkillsPath(dorkHome),
    reason: `DorkOS could not read the list of running extensions' skills (${reason}), so no extension skill was planned. DorkOS rewrites it the next time it scans extensions.`,
  };
}

/** The real path of `p`, or `p` resolved when it does not exist. */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * The local extensions whose skills belong in one project.
 *
 * An entry joins only when its `projectRoot` is this repository (compared
 * through real paths, so a project opened through a link still matches) and
 * its `skillsDir` sits where a local extension's running copy can live: inside
 * the project (`.dork/extensions/<id>` or a project plugin's
 * `.dork/plugins/<p>/.dork/extensions/<id>`), or inside DorkOS's own verified
 * snapshots. The check is lexical on purpose: a dev-linked plugin's slot is a
 * link into a working folder elsewhere, and its path through the slot is the
 * one the server records.
 *
 * @param ledger - what {@link readRunningExtensionSkillsSync} returned.
 * @param opts.projectRoot - the repository being synced, absolute.
 * @param opts.dorkHome - the DorkOS data directory, absolute.
 * @returns the packages to project and the warnings to print.
 */
export function localExtensionSkillPackages(
  ledger: RunningExtensionSkills,
  opts: { projectRoot: string; dorkHome: string }
): ExtensionSkillScan {
  if (ledger.state === 'unreadable') {
    return {
      packages: [],
      warnings: [unreadableLedgerWarning(opts.dorkHome, ledger.reason ?? 'invalid')],
    };
  }
  const repo = canonical(opts.projectRoot);
  const snapshots = resolve(opts.dorkHome, 'extension-snapshots');
  const entries = ledger.entries.filter((entry) => {
    if (entry.scope !== 'local' || entry.projectRoot === undefined) return false;
    if (canonical(entry.projectRoot) !== repo) return false;
    const dir = resolve(entry.skillsDir);
    return isInside(dir, resolve(entry.projectRoot)) || isInside(dir, snapshots);
  });
  return toPackages(entries, (entry, skill) => join(entry.skillsDir, skill));
}

/**
 * The global extensions whose skills every project gets.
 *
 * Their skills are checked in the running copy, but every projection points
 * through the generated plugin root
 * (`{dorkHome}/cache/extensions/skill-plugins/<id>/skills/<name>`), the same
 * folder DorkOS's Claude Code sessions load: the global sweep owns links into
 * that root, and the server removing a root withdraws its skills from every
 * tier at once, before any sweep runs. An entry whose `skillsDir` is not under
 * `{dorkHome}/extensions` or `{dorkHome}/plugins` (where a global extension
 * lives) is ignored.
 *
 * @param ledger - what {@link readRunningExtensionSkillsSync} returned.
 * @param dorkHome - the DorkOS data directory, absolute.
 * @returns the packages to project and the warnings to print.
 */
export function globalExtensionSkillPackages(
  ledger: RunningExtensionSkills,
  dorkHome: string
): ExtensionSkillScan {
  if (ledger.state === 'unreadable') {
    return {
      packages: [],
      warnings: [unreadableLedgerWarning(dorkHome, ledger.reason ?? 'invalid')],
    };
  }
  const roots = [resolve(dorkHome, 'extensions'), resolve(dorkHome, 'plugins')];
  const entries = ledger.entries.filter(
    (entry) =>
      entry.scope === 'global' && roots.some((root) => isInside(resolve(entry.skillsDir), root))
  );
  return toPackages(entries, (entry, skill) =>
    join(extensionSkillPluginRoot(dorkHome, entry.id), 'skills', skill)
  );
}

/**
 * Whether a projected link points into an extension's folder: its own text,
 * resolved lexically against the folder it sits in (never followed), runs
 * through a `.dork/extensions/` folder or DorkOS's `extension-snapshots/`.
 *
 * The project sweep asks this so an absent or unreadable ledger can keep
 * extension links rather than delete them: a link to a plugin's own skill
 * never runs through either folder.
 *
 * @param absLink - the absolute path of a link in a skills folder.
 * @returns true when the link's text names an extension's folder.
 */
export function isExtensionSkillLink(absLink: string): boolean {
  let text: string;
  try {
    text = readlinkSync(absLink);
  } catch {
    return false;
  }
  const parts = resolve(dirname(absLink), text).split(sep);
  return parts.some(
    (part, i) =>
      part === 'extension-snapshots' || (part === '.dork' && parts[i + 1] === 'extensions')
  );
}
