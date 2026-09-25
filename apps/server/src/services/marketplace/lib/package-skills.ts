/**
 * Read what a Claude Code plugin's skills and commands can run, for the
 * permission preview: the `hooks` and the `allowed-tools` in each one's
 * frontmatter (DOR-2195), and the shell commands its text runs when it is used,
 * `` !`cmd` `` and ```` ```! ```` blocks (DOR-2327, `@dorkos/skills/shell-commands`).
 *
 * A skill is invoked by the model on the strength of its description, not only
 * by name, so a skill described as "use for every task" is in play all the time.
 * Claude Code registers the hooks in a skill's frontmatter while that skill is
 * in use, with no exclusion for plugin skills, and `allowed-tools` lets it use
 * those tools without a permission prompt. Both are therefore disclosed, bound
 * and shown like the plugin's own hooks. Commands are skills to Claude Code and
 * carry the same frontmatter.
 *
 * Where they live, per the plugins reference: `skills/<name>/SKILL.md` and a
 * root `SKILL.md` (plus whatever plugin.json `skills` adds), and the `.md` files
 * under `commands/` (which plugin.json `commands` replaces). Every file is read
 * through {@link readPackageText}, so nothing outside the package is opened.
 *
 * Frontmatter is read with `parseFrontmatter`, which refuses anything but YAML
 * or JSON (`---js` would otherwise run as code, DOR-2308) and anything that is
 * not `key: value` fields. A file it refuses is reported unreadable, and so is
 * never approvable.
 *
 * @module services/marketplace/lib/package-skills
 */
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, join, normalize, posix } from 'node:path';
import { parseFrontmatter } from '@dorkos/skills/frontmatter';
import type { PreviewSkillCommand, PreviewSkillTools } from '../types.js';
import { findSkillShellCommands, usesTypedArguments } from '@dorkos/skills/shell-commands';
import { collectHooks, type PackageHooks } from './package-hooks.js';
import { readPackageText } from './package-declarations.js';
import { EFFECT_BEARING_PATHS } from '@dorkos/marketplace';

/** What {@link readPackageSkills} found. */
export interface PackageSkills extends PackageHooks {
  /** Every skill or command that lets the agent use tools without asking. */
  skillTools: PreviewSkillTools[];
  /** Every shell command a skill's or command's text runs when it is used (DOR-2327). */
  skillCommands: PreviewSkillCommand[];
}

/** How deep a skills or commands folder is walked; deeper trees are unusual. */
const MAX_DEPTH = 4;

/**
 * Every file under a package-relative directory that `keep` accepts, never
 * following a link and never leaving the directory.
 *
 * @param packagePath - Absolute path to the staged package.
 * @param dir - The package-relative directory.
 * @param keep - Which file names to collect.
 * @param skipLinks - Leave links out instead of listing them as unreadable.
 * @returns Package-relative file paths, sorted.
 */
async function filesUnder(
  packagePath: string,
  dir: string,
  keep: (name: string) => boolean,
  skipLinks = false
): Promise<string[]> {
  const found: string[] = [];
  async function visit(rel: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      const stats = await lstat(join(packagePath, rel));
      if (!stats.isDirectory()) return;
      entries = await readdir(join(packagePath, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = posix.join(rel, entry.name);
      if (skipLinks && entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(child, depth + 1);
      // A link is listed so reading it reports it unreadable rather than
      // following it somewhere else.
      else if (keep(entry.name)) found.push(child);
    }
  }
  await visit(normalize(dir).split('\\').join('/'), 0);
  return found.sort();
}

/**
 * Every skill and command file the package declares, package-relative.
 *
 * @param packagePath - Absolute path to the staged package.
 * @param pluginJson - The package's plugin.json, when it has a readable one.
 * @returns The files, deduplicated, in a stable order.
 */
async function skillFilesOf(
  packagePath: string,
  pluginJson: Record<string, unknown> | undefined,
  agentWorkspace: boolean
): Promise<string[]> {
  const listOf = (value: unknown): string[] =>
    (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter(
      (v): v is string => typeof v === 'string'
    );
  const isSkill = (name: string) => name === 'SKILL.md';
  const isMarkdown = (name: string) => name.endsWith('.md');

  const files = new Set<string>();
  const add = (paths: string[]) => paths.forEach((p) => files.add(p));
  const fromPath = async (path: string, keep: (name: string) => boolean) => {
    if (path.endsWith('.md')) add([normalize(path).split('\\').join('/')]);
    else add(await filesUnder(packagePath, path, keep));
  };

  add(await filesUnder(packagePath, EFFECT_BEARING_PATHS.skills, isSkill));
  const rootSkill = await readPackageText(packagePath, EFFECT_BEARING_PATHS.rootSkill);
  if (rootSkill.kind !== 'absent') files.add(EFFECT_BEARING_PATHS.rootSkill);
  for (const path of listOf(pluginJson?.skills)) await fromPath(path, isSkill);

  // `commands` in plugin.json replaces the default folder.
  const commandPaths =
    pluginJson?.commands !== undefined
      ? listOf(pluginJson.commands)
      : [EFFECT_BEARING_PATHS.commands];
  for (const path of commandPaths) await fromPath(path, isMarkdown);

  if (agentWorkspace) {
    for (const { dir, kind } of AGENT_WORKSPACE_SKILL_DIRS) {
      add(await filesUnder(packagePath, dir, kind === 'skill' ? isSkill : isMarkdown, true));
    }
  }

  return [...files];
}

/**
 * Where an agent's own sessions load skills and commands from its working
 * directory (DOR-2314): Claude Code's project folders, and the Harness Sync
 * source DorkOS projects into them. Read only for an agent package, whose
 * folder IS that working directory. Links there are skipped: staging strips a
 * package's links, and in an installed agent they are DorkOS's own projections
 * of `.agents/skills`, which is read directly.
 */
const AGENT_WORKSPACE_SKILL_DIRS = [
  { dir: '.claude/skills', kind: 'skill' },
  { dir: '.claude/commands', kind: 'command' },
  { dir: '.agents/skills', kind: 'skill' },
] as const;

/** A skill's name: its frontmatter `name`, else its folder (or file) name. */
function skillNameOf(path: string, data: Record<string, unknown>): string {
  if (typeof data.name === 'string' && data.name.length > 0) return data.name;
  return basename(path) === 'SKILL.md' ? basename(dirname(path)) : basename(path, '.md');
}

/** The names in frontmatter `arguments`: a YAML list or a space-separated string. */
function argumentNamesOf(data: Record<string, unknown>): string[] {
  const value = data.arguments;
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  return [];
}

/** The shell commands a file's text runs, tagged with the file. */
function commandsOf(
  path: string,
  data: Record<string, unknown>,
  text: string
): PreviewSkillCommand[] {
  const skill = skillNameOf(path, data);
  const names = argumentNamesOf(data);
  return findSkillShellCommands(text).map((found) => ({
    source: path,
    skill,
    ...found,
    usesArguments: usesTypedArguments(found.command, names),
  }));
}

/**
 * Agent and output-style files, read for their text's shell commands only
 * (DOR-2327): a plugin's `agents/` and `output-styles/`, and the same folders
 * under `.claude/`, where an agent package's own sessions load them. Whether
 * Claude Code runs `!` commands in these is not documented; disclosing them
 * is the conservative reading. Their frontmatter hooks stay unread: Claude
 * Code ignores `hooks` in a plugin agent.
 */
const TEXT_ONLY_DIRS = [
  EFFECT_BEARING_PATHS.agents,
  EFFECT_BEARING_PATHS.outputStyles,
  '.claude/agents',
  '.claude/output-styles',
] as const;

/** `allowed-tools`, as a string list or a comma/space-separated string. */
function toolsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((t): t is string => typeof t === 'string');
  if (typeof value === 'string') {
    return value
      .split(/,\s*|\s+(?![^(]*\))/)
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Every hook and allowed tool declared in the frontmatter of the package's
 * skills and commands.
 *
 * @param packagePath - Absolute path to the staged package.
 * @param pluginJson - The package's plugin.json, when it has a readable one.
 * @param agentWorkspace - The package is an agent, whose folder is its
 *   working directory: also read the skills its sessions load from there.
 * @returns Hooks (each with its `source`), allowed tools, and every file whose
 *   frontmatter could not be read.
 */
export async function readPackageSkills(
  packagePath: string,
  pluginJson: Record<string, unknown> | undefined,
  agentWorkspace = false
): Promise<PackageSkills> {
  const out: PackageSkills = { hooks: [], unreadable: [], skillTools: [], skillCommands: [] };
  for (const path of await skillFilesOf(packagePath, pluginJson, agentWorkspace)) {
    const read = await readPackageText(packagePath, path);
    if (read.kind === 'absent') continue;
    if (read.kind === 'unreadable') {
      out.unreadable.push({ path });
      continue;
    }
    let data: Record<string, unknown>;
    try {
      data = parseFrontmatter(read.text).data;
    } catch {
      out.unreadable.push({ path });
      // The file is not approvable either way, but the card still shows what
      // its text would run.
      out.skillCommands.push(...commandsOf(path, {}, read.text));
      continue;
    }
    out.skillCommands.push(...commandsOf(path, data, read.text));
    if (data.hooks !== undefined) collectHooks(data.hooks, path, out, path);
    const tools = toolsOf(data['allowed-tools']);
    if (tools.length > 0)
      out.skillTools.push({ source: path, skill: skillNameOf(path, data), tools });
  }
  for (const dir of TEXT_ONLY_DIRS) {
    for (const path of await filesUnder(packagePath, dir, (name) => name.endsWith('.md'))) {
      const read = await readPackageText(packagePath, path);
      if (read.kind === 'absent') continue;
      if (read.kind === 'unreadable') {
        // Commands it may run could not be shown, so it is never approvable.
        out.unreadable.push({ path });
        continue;
      }
      let data: Record<string, unknown> = {};
      try {
        data = parseFrontmatter(read.text).data;
      } catch {
        // Its name falls back to the file name; the text is read either way.
      }
      out.skillCommands.push(...commandsOf(path, data, read.text));
    }
  }
  return out;
}
