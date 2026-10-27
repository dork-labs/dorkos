/**
 * The code an agent's own hooks and agent files point at, for the `hooks` part
 * of its folder settings pin (DOR-3068, `folder-config-pin.ts`):
 *
 * - **Hook scripts** ({@link hookScriptFiles}): every file under
 *   `<home>/.claude/hooks/`, and every file a hook, status line or helper
 *   command names, by a relative path or `$CLAUDE_PROJECT_DIR` inside the home,
 *   or by an absolute path inside the home, `<dorkHome>/plugins/` or any
 *   `.dork/plugins/` (where a projected plugin hook's `${CLAUDE_PLUGIN_ROOT}`
 *   has been rewritten to). Read with lstat: a symlink, a file over 64 KB, more
 *   than 200 files or a tree deeper than four levels can't be vouched for.
 * - **Agent and skill frontmatter** ({@link agentFileHooks}): the `hooks` and
 *   `mcpServers` fields only, of `<home>/.claude/agents/**\/*.md` and
 *   `<home>/.claude/skills/*\/SKILL.md`, so editing a skill's words asks
 *   nobody. These follow symlinks, because DorkOS itself links skills in.
 *
 * Not covered (the residual): a file a hook script imports or sources, a
 * script a command names anywhere else (`~`, a program on `PATH`, an absolute
 * path outside the roots above, a variable), and a symlinked folder partway up
 * a named path. Codex and OpenCode don't read any of this.
 *
 * @module services/runtimes/claude-code/folder-settings/folder-config-scripts
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '@dorkos/skills/frontmatter';

/** The largest file read. A real one is a few kilobytes. */
const MAX_FILE_BYTES = 64 * 1024;

/** The most files hashed for one home, per kind. */
const MAX_FILES = 200;

/** How deep `.claude/hooks/` and `.claude/agents/` are walked. */
const MAX_DEPTH = 4;

/** Stands in for the home while a command is split, so a space in the home's path survives. */
const HOME_MARK = '\u0000home\u0000';

/** `$CLAUDE_PROJECT_DIR` and `${CLAUDE_PROJECT_DIR}`. */
const PROJECT_DIR_VAR = /\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR\b/g;

/** An output redirect and its target (`> log.txt`, `2>> err.log`); `<` input is kept. */
const OUTPUT_REDIRECT = /\d*>>?\s*\S+/g;

/** What separates words in a shell command, for finding the paths in it. */
const WORD_BREAK = /[\s;&|<>()`=]+/;

/** A word that looks like a file: it has a slash, or ends in an extension. */
const PATH_LIKE = /\/|\.[A-Za-z0-9]+$/;

/** Whether `target` is strictly inside `base`. */
function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** sha256 of bytes or text, hex. */
function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * The absolute paths `commands` name that are worth hashing: inside the home
 * (relative, `$CLAUDE_PROJECT_DIR` or absolute), or inside a plugin folder.
 */
function namedTargets(root: string, pluginsRoot: string, commands: readonly string[]): string[] {
  const found = new Set<string>();
  const pluginSegment = `${path.sep}.dork${path.sep}plugins${path.sep}`;
  for (const command of commands) {
    const words = command
      .replace(/["']/g, '')
      // A file a command writes its output to is not code it runs, and a log
      // that changed on every run would ask a person again after each one.
      .replace(OUTPUT_REDIRECT, ' ')
      .replace(PROJECT_DIR_VAR, HOME_MARK)
      .split(WORD_BREAK);
    for (const word of words) {
      if (!word) continue;
      if (word.startsWith(HOME_MARK)) {
        const target = path.join(root, word.slice(HOME_MARK.length).split(HOME_MARK).join(root));
        if (isInside(root, target)) found.add(target);
      } else if (path.isAbsolute(word)) {
        const target = path.resolve(word);
        if (
          isInside(root, target) ||
          isInside(pluginsRoot, target) ||
          target.includes(pluginSegment)
        ) {
          found.add(target);
        }
      } else if (
        !word.startsWith('~') &&
        !word.startsWith('$') &&
        !word.startsWith('-') &&
        PATH_LIKE.test(word)
      ) {
        const target = path.resolve(root, word);
        if (isInside(root, target)) found.add(target);
      }
    }
  }
  return [...found];
}

/**
 * The scripts the hooks run, each with its content hash, sorted by path: a
 * path inside the home is relative, any other is absolute. `absent` for a named
 * file that is not there (so creating it is a change), `dir` for a named
 * folder. `undefined` when one can't be vouched for: a symlink, something that
 * is not a regular file or folder, a file over 64 KB, an unreadable one, a
 * tree deeper than four levels, or more than 200 files.
 *
 * @param home - The registered agent home.
 * @param commands - Every hook, status line and helper command in its settings.
 * @param dorkHome - DorkOS's data folder, whose `plugins/` installed hooks run from.
 */
export function hookScriptFiles(
  home: string,
  commands: readonly string[],
  dorkHome: string
): [string, string][] | undefined {
  const root = path.resolve(home);
  const entries = new Map<string, string>();
  let files = 0;
  const hash = (abs: string): boolean => {
    if (entries.has(abs)) return true;
    let stat;
    try {
      stat = lstatSync(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      entries.set(abs, 'absent');
      return true;
    }
    if (stat.isDirectory()) {
      entries.set(abs, 'dir');
      return true;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || files >= MAX_FILES) return false;
    try {
      const content = readFileSync(abs);
      if (content.byteLength > MAX_FILE_BYTES) return false;
      files += 1;
      entries.set(abs, sha256(content));
      return true;
    } catch {
      return false;
    }
  };
  const walk = (abs: string, depth: number): boolean => {
    let stat;
    try {
      stat = lstatSync(abs);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT';
    }
    if (!stat.isDirectory() || depth > MAX_DEPTH) return false;
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return false;
    }
    for (const name of names) {
      const child = path.join(abs, name);
      let childStat;
      try {
        childStat = lstatSync(child);
      } catch {
        return false;
      }
      if (!(childStat.isDirectory() ? walk(child, depth + 1) : hash(child))) return false;
    }
    return true;
  };
  if (!walk(path.join(root, '.claude', 'hooks'), 1)) return undefined;
  for (const target of namedTargets(root, path.resolve(dorkHome, 'plugins'), commands)) {
    if (!hash(target)) return undefined;
  }
  return sortedByPath(root, entries);
}

/** Map entries keyed by absolute path to `[path, value]`, relative inside the home, sorted. */
function sortedByPath<T>(root: string, entries: Map<string, T>): [string, T][] {
  return [...entries]
    .map(([abs, value]): [string, T] => [
      isInside(root, abs) ? path.relative(root, abs).split(path.sep).join('/') : abs,
      value,
    ])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The frontmatter fields that make an agent or skill run code or start servers. */
const AGENT_FILE_FIELDS = [
  'hooks',
  'mcpServers',
  // Fields that let a skill, command or subagent skip DorkOS's permission
  // check or raise its own mode (DOR-3068 M2).
  'allowed-tools',
  'tools',
  'disallowedTools',
  'permissionMode',
] as const;

/**
 * The power-widening frontmatter (`AGENT_FILE_FIELDS`) of the home's subagents, skills and commands,
 * by path, for files that set either; `undefined` when one can't be vouched
 * for (over 64 KB, unreadable, not a file, too deep, more than 200 files).
 * Frontmatter that does not parse is a value of its own (its block's hash),
 * so a broken one is a change, but the words below it never are.
 *
 * @param home - The registered agent home.
 */
export function agentFileHooks(home: string): [string, unknown][] | undefined {
  const root = path.resolve(home);
  const entries = new Map<string, unknown>();
  let files = 0;
  const read = (abs: string): boolean => {
    let stat;
    try {
      stat = statSync(abs);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT';
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || files >= MAX_FILES) return false;
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      return false;
    }
    files += 1;
    let picked: Record<string, unknown>;
    try {
      const { data } = parseFrontmatter(text);
      picked = {};
      for (const field of AGENT_FILE_FIELDS) {
        if (Object.hasOwn(data, field)) picked[field] = data[field];
      }
    } catch {
      const block = /^---[^\n]*\n([\s\S]*?)\n---/.exec(text)?.[1] ?? text;
      picked = { unparseable: sha256(block) };
    }
    if (Object.keys(picked).length > 0) entries.set(abs, picked);
    return true;
  };
  const listDir = (abs: string): string[] | null | undefined => {
    try {
      if (!statSync(abs).isDirectory()) return undefined;
      return readdirSync(abs);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
    }
  };
  const walkAgents = (abs: string, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    const names = listDir(abs);
    if (names === null) return true;
    if (names === undefined) return false;
    for (const name of names) {
      const child = path.join(abs, name);
      const sub = listDir(child);
      if (sub !== undefined && sub !== null) {
        if (!walkAgents(child, depth + 1)) return false;
      } else if (name.endsWith('.md') && !read(child)) {
        return false;
      }
    }
    return true;
  };
  if (!walkAgents(path.join(root, '.claude', 'agents'), 1)) return undefined;
  // Commands share the skill frontmatter, so they can carry hooks and tools too.
  if (!walkAgents(path.join(root, '.claude', 'commands'), 1)) return undefined;
  const skillsDir = path.join(root, '.claude', 'skills');
  const skills = listDir(skillsDir);
  if (skills === undefined) return undefined;
  for (const name of skills ?? []) {
    if (!read(path.join(skillsDir, name, 'SKILL.md'))) {
      // A plain file beside the skill folders is not a skill.
      if (listDir(path.join(skillsDir, name)) !== undefined) return undefined;
    }
  }
  return sortedByPath(root, entries);
}
