/**
 * Read what a Claude Code plugin's skills and commands can run, for the
 * permission preview: the `hooks` and the `allowed-tools` in each one's
 * frontmatter (DOR-2195).
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
 * ## Frontmatter is parsed as data only
 *
 * gray-matter evaluates `---js` frontmatter with `eval`. A package is untrusted
 * until a person approves it, and this preview runs before that, so every
 * engine but YAML and JSON is replaced with one that refuses; a file that asks
 * for one is reported unreadable, and so never approvable.
 *
 * @module services/marketplace/lib/package-skills
 */
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, join, normalize, posix } from 'node:path';
import matter from 'gray-matter';
import type { PreviewSkillTools } from '../types.js';
import { collectHooks, type PackageHooks } from './package-hooks.js';
import { isRecord, readPackageText } from './package-declarations.js';

/** What {@link readPackageSkills} found. */
export interface PackageSkills extends PackageHooks {
  /** Every skill or command that lets the agent use tools without asking. */
  skillTools: PreviewSkillTools[];
}

/** An engine that refuses, for every frontmatter language that is not plain data. */
const refuse = {
  parse: (): never => {
    throw new Error('only YAML and JSON frontmatter is read');
  },
};

/** gray-matter options that parse YAML and JSON only, never code. */
const DATA_ONLY = {
  engines: { js: refuse, javascript: refuse, coffee: refuse, coffeescript: refuse, cson: refuse },
};

/** How deep a skills or commands folder is walked; deeper trees are unusual. */
const MAX_DEPTH = 4;

/**
 * Every file under a package-relative directory that `keep` accepts, never
 * following a link and never leaving the directory.
 *
 * @param packagePath - Absolute path to the staged package.
 * @param dir - The package-relative directory.
 * @param keep - Which file names to collect.
 * @returns Package-relative file paths, sorted.
 */
async function filesUnder(
  packagePath: string,
  dir: string,
  keep: (name: string) => boolean
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
  pluginJson: Record<string, unknown> | undefined
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

  add(await filesUnder(packagePath, 'skills', isSkill));
  const rootSkill = await readPackageText(packagePath, 'SKILL.md');
  if (rootSkill.kind !== 'absent') files.add('SKILL.md');
  for (const path of listOf(pluginJson?.skills)) await fromPath(path, isSkill);

  // `commands` in plugin.json replaces the default folder.
  const commandPaths =
    pluginJson?.commands !== undefined ? listOf(pluginJson.commands) : ['commands'];
  for (const path of commandPaths) await fromPath(path, isMarkdown);

  return [...files];
}

/** A skill's name: its frontmatter `name`, else its folder (or file) name. */
function skillNameOf(path: string, data: Record<string, unknown>): string {
  if (typeof data.name === 'string' && data.name.length > 0) return data.name;
  return basename(path) === 'SKILL.md' ? basename(dirname(path)) : basename(path, '.md');
}

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
 * @returns Hooks (each with its `source`), allowed tools, and every file whose
 *   frontmatter could not be read.
 */
export async function readPackageSkills(
  packagePath: string,
  pluginJson: Record<string, unknown> | undefined
): Promise<PackageSkills> {
  const out: PackageSkills = { hooks: [], unreadable: [], skillTools: [] };
  for (const path of await skillFilesOf(packagePath, pluginJson)) {
    const read = await readPackageText(packagePath, path);
    if (read.kind === 'absent') continue;
    if (read.kind === 'unreadable') {
      out.unreadable.push({ path });
      continue;
    }
    let data: Record<string, unknown>;
    try {
      const parsed = matter(read.text, DATA_ONLY);
      data = isRecord(parsed.data) ? parsed.data : {};
    } catch {
      out.unreadable.push({ path });
      continue;
    }
    if (data.hooks !== undefined) collectHooks(data.hooks, path, out, path);
    const tools = toolsOf(data['allowed-tools']);
    if (tools.length > 0)
      out.skillTools.push({ source: path, skill: skillNameOf(path, data), tools });
  }
  return out;
}
