/**
 * What a person approves when they let an agent's own folder settings run
 * (DOR-3068): a digest of the three places an agent could hand itself more
 * power by rewriting a file in its home, each hashed on its own so a card can
 * say which one changed.
 *
 * - **`hooks`**: from `<home>/.claude/settings.json` and `settings.local.json`,
 *   only the keys that make code run or pick which MCP servers start
 *   ({@link CODE_SETTINGS_KEYS}), plus the CONTENTS of the scripts those hooks
 *   run: every file under `<home>/.claude/hooks/`, and every file inside the
 *   home a hook or status line `command` names by a relative or
 *   `$CLAUDE_PROJECT_DIR` path ({@link hookScriptFiles}). A script a command
 *   names outside the home (an absolute path elsewhere, `~`, a program on
 *   `PATH`) is NOT covered: that is the residual, and the agent's shell can
 *   still edit such a file.
 * - **`mcpJson`**: `<home>/.mcp.json`, whole.
 * - **`manifest`**: `<home>/.dork/agent.json`, only `mcpServers` and `account`.
 *
 * Every file is read the way Claude Code would read it, so the digest covers
 * what actually runs: a symlinked file is followed, and its target's text is
 * what is hashed. A file that is missing is `null`. A file that is not a
 * regular file, or is too big to read on every launch, can't be vouched for
 * at all: its part is {@link FolderConfigParts.unverifiable}, which never
 * matches an approval. A file that is not valid JSON is a value of its own
 * (its text's hash), so a malformed file is a change like any other.
 *
 * Synchronous on purpose: the launch, the harness projection and the routes
 * that re-pin all read it, and the files are capped at 64 KB.
 *
 * @module services/runtimes/claude-code/folder-settings/folder-config-pin
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** The three parts a pin is made of, in the order a card names them. */
export const FOLDER_CONFIG_PARTS = ['hooks', 'mcpJson', 'manifest'] as const;

/** One of {@link FOLDER_CONFIG_PARTS}. */
export type FolderConfigPart = (typeof FOLDER_CONFIG_PARTS)[number];

/** The per-part digests of one agent home's folder settings. */
export type FolderConfigDigests = Record<FolderConfigPart, string>;

/** The digests now, and which parts can't be vouched for. */
export interface FolderConfigParts {
  /** sha256 of each part's canonical value. */
  digests: FolderConfigDigests;
  /** Parts holding a file DorkOS could not read: never approved, never asked about. */
  unverifiable: FolderConfigPart[];
}

/**
 * The keys of a folder's Claude Code settings that run code or decide which
 * MCP servers start. Nothing else in the file is pinned: a changed allow list
 * has its own approval (`agent-folder-allows.ts`), and the rest is preference.
 */
export const CODE_SETTINGS_KEYS = [
  'hooks',
  'statusLine',
  'enabledPlugins',
  'extraKnownMarketplaces',
  'enableAllProjectMcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
] as const;

/** The settings files read for {@link CODE_SETTINGS_KEYS}, in Claude Code's order. */
const SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const;

/** The largest file read. A real one is a few kilobytes. */
const MAX_FILE_BYTES = 64 * 1024;

/** What one file read gave. */
type FileRead =
  | { kind: 'absent' }
  | { kind: 'unverifiable' }
  | { kind: 'malformed'; text: string }
  | { kind: 'parsed'; value: unknown };

/** Read one file as Claude Code would: following a symlink, regular files only, capped. */
function readJsonFile(file: string): FileRead {
  let size: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return { kind: 'unverifiable' };
    size = stat.size;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unverifiable' };
  }
  if (size > MAX_FILE_BYTES) return { kind: 'unverifiable' };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { kind: 'unverifiable' };
  }
  // Read twice over a race: a file that grew past the cap since the stat is
  // still one DorkOS won't read on every launch.
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) return { kind: 'unverifiable' };
  try {
    return { kind: 'parsed', value: JSON.parse(text) as unknown };
  } catch {
    return { kind: 'malformed', text };
  }
}

/**
 * JSON with every object's keys sorted, at every depth, so two files that say
 * the same thing in a different order digest the same.
 *
 * @param value - Any JSON value.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** A copy of `value` with object keys sorted. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** sha256 of a string, hex. */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A malformed file as a value: its text's hash, never its text. */
function malformed(text: string): { malformed: string } {
  return { malformed: sha256(text) };
}

/** Only the named keys of a parsed object; a non-object is kept whole. */
function pick(value: unknown, keys: readonly string[]): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { notAnObject: value };
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(value, key)) out[key] = (value as Record<string, unknown>)[key];
  }
  return out;
}

/**
 * An agent file's `mcpServers` as it bears on what runs: each entry without its
 * audit fields (`addedAt`, `addedBy`) and without `connection.authKind`, which
 * DorkOS writes itself when it learns a server wants a sign-in and which
 * changes nothing about what is started or where a token is sent.
 */
function servers(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const { addedAt: _at, addedBy: _by, ...rest } = entry as Record<string, unknown>;
    const connection = rest.connection;
    if (connection !== null && typeof connection === 'object' && !Array.isArray(connection)) {
      const { authKind: _kind, ...kept } = connection as Record<string, unknown>;
      return { ...rest, connection: kept };
    }
    return rest;
  });
}

/** A part's value and whether every file behind it could be read. */
interface PartValue {
  value: unknown;
  verifiable: boolean;
}

/** The `hooks` part: the code-running keys of both settings files, and the scripts they run. */
function hooksPart(home: string): PartValue {
  const value: Record<string, unknown> = {};
  let verifiable = true;
  const commands: string[] = [];
  for (const name of SETTINGS_FILES) {
    const read = readJsonFile(path.join(home, '.claude', name));
    if (read.kind === 'unverifiable') verifiable = false;
    const picked = read.kind === 'parsed' ? pick(read.value, CODE_SETTINGS_KEYS) : undefined;
    if (picked !== undefined) collectCommands(picked, commands);
    value[name] =
      picked !== undefined
        ? picked
        : read.kind === 'malformed'
          ? malformed(read.text)
          : read.kind === 'absent'
            ? null
            : { unverifiable: true };
  }
  const files = hookScriptFiles(home, commands);
  if (files === undefined)
    return { value: { ...value, files: { unverifiable: true } }, verifiable: false };
  return { value: { ...value, files }, verifiable };
}

/** Every string `command` anywhere under a parsed settings slice. */
function collectCommands(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectCommands(item, out);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'command' && typeof child === 'string') out.push(child);
    else collectCommands(child, out);
  }
}

/** The most script files hashed for one home, and how deep `.claude/hooks/` is walked. */
const MAX_SCRIPT_FILES = 200;
const MAX_HOOKS_DEPTH = 4;

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

/**
 * The paths inside `home` that `commands` name: relative words that look like
 * files, and anything under `$CLAUDE_PROJECT_DIR`. Absolute paths elsewhere,
 * `~`, other variables and `..` that leaves the home are left out (residual).
 */
function namedPaths(home: string, commands: readonly string[]): string[] {
  const root = path.resolve(home);
  const found = new Set<string>();
  for (const command of commands) {
    const words = command
      .replace(/["']/g, '')
      // A file a command writes its output to is not code it runs, and a log
      // that changed on every run would ask a person again after each one.
      .replace(OUTPUT_REDIRECT, ' ')
      .replace(PROJECT_DIR_VAR, HOME_MARK)
      .split(WORD_BREAK);
    for (const word of words) {
      let target: string | undefined;
      if (word.startsWith(HOME_MARK)) {
        target = path.join(root, word.slice(HOME_MARK.length).split(HOME_MARK).join(root));
      } else if (
        word &&
        !word.startsWith('/') &&
        !word.startsWith('~') &&
        !word.startsWith('$') &&
        !word.startsWith('-') &&
        PATH_LIKE.test(word)
      ) {
        target = path.resolve(root, word);
      }
      if (target === undefined) continue;
      const rel = path.relative(root, target);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) found.add(rel);
    }
  }
  return [...found];
}

/**
 * The scripts the hooks run, by relative path, each with its content hash:
 * every file under `.claude/hooks/` and every file a command names inside the
 * home. `absent` for a named file that is not there (so creating it is a
 * change), `dir` for a named folder. `undefined` when one can't be vouched
 * for: a symlink, something that is not a regular file or folder, a file over
 * 64 KB, an unreadable one, a tree deeper than {@link MAX_HOOKS_DEPTH} or more
 * than {@link MAX_SCRIPT_FILES} files.
 *
 * @param home - The registered agent home.
 * @param commands - Every hook and status line command in its settings.
 */
export function hookScriptFiles(
  home: string,
  commands: readonly string[]
): [string, string][] | undefined {
  const root = path.resolve(home);
  const entries = new Map<string, string>();
  const hash = (rel: string): boolean => {
    if (entries.has(rel)) return true;
    let stat;
    try {
      stat = lstatSync(path.join(root, rel));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      entries.set(rel, 'absent');
      return true;
    }
    if (stat.isDirectory()) {
      entries.set(rel, 'dir');
      return true;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return false;
    if (entries.size >= MAX_SCRIPT_FILES) return false;
    try {
      const content = readFileSync(path.join(root, rel));
      if (content.byteLength > MAX_FILE_BYTES) return false;
      entries.set(rel, createHash('sha256').update(content).digest('hex'));
      return true;
    } catch {
      return false;
    }
  };
  const walk = (rel: string, depth: number): boolean => {
    let stat;
    try {
      stat = lstatSync(path.join(root, rel));
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT';
    }
    if (!stat.isDirectory()) return false;
    if (depth > MAX_HOOKS_DEPTH) return false;
    let names: string[];
    try {
      names = readdirSync(path.join(root, rel));
    } catch {
      return false;
    }
    for (const name of names) {
      const child = path.join(rel, name);
      let childStat;
      try {
        childStat = lstatSync(path.join(root, child));
      } catch {
        return false;
      }
      const ok = childStat.isDirectory() ? walk(child, depth + 1) : hash(child);
      if (!ok) return false;
    }
    return true;
  };
  if (!walk(path.join('.claude', 'hooks'), 1)) return undefined;
  for (const rel of namedPaths(root, commands)) {
    if (!hash(rel)) return undefined;
  }
  return [...entries]
    .map(([rel, digest]): [string, string] => [rel.split(path.sep).join('/'), digest])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The `mcpJson` part: the whole `.mcp.json`. */
function mcpJsonPart(home: string): PartValue {
  const read = readJsonFile(path.join(home, '.mcp.json'));
  if (read.kind === 'unverifiable') return { value: { unverifiable: true }, verifiable: false };
  if (read.kind === 'malformed') return { value: malformed(read.text), verifiable: true };
  return { value: read.kind === 'parsed' ? read.value : null, verifiable: true };
}

/** The `manifest` part: the agent file's `mcpServers` and `account`. */
function manifestPart(home: string): PartValue {
  const read = readJsonFile(path.join(home, '.dork', 'agent.json'));
  if (read.kind === 'unverifiable') return { value: { unverifiable: true }, verifiable: false };
  if (read.kind === 'malformed') return { value: malformed(read.text), verifiable: true };
  if (read.kind === 'absent') return { value: null, verifiable: true };
  const manifest = read.value;
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { value: { notAnObject: manifest }, verifiable: true };
  }
  const fields = manifest as Record<string, unknown>;
  return {
    value: {
      mcpServers: Object.hasOwn(fields, 'mcpServers') ? servers(fields.mcpServers) : null,
      account: Object.hasOwn(fields, 'account') ? fields.account : null,
    },
    verifiable: true,
  };
}

/**
 * Read an agent home's folder settings and digest each part.
 *
 * @param home - The registered agent home.
 */
export function readFolderConfigParts(home: string): FolderConfigParts {
  const values: Record<FolderConfigPart, PartValue> = {
    hooks: hooksPart(home),
    mcpJson: mcpJsonPart(home),
    manifest: manifestPart(home),
  };
  const digests = {} as FolderConfigDigests;
  const unverifiable: FolderConfigPart[] = [];
  for (const part of FOLDER_CONFIG_PARTS) {
    digests[part] = sha256(canonicalJson(values[part].value));
    if (!values[part].verifiable) unverifiable.push(part);
  }
  return { digests, unverifiable };
}

/**
 * The parts whose digest differs between two readings, in card order.
 *
 * @param now - The digests now.
 * @param approved - The digests a person approved.
 */
export function changedParts(
  now: FolderConfigDigests,
  approved: FolderConfigDigests
): FolderConfigPart[] {
  return FOLDER_CONFIG_PARTS.filter((part) => now[part] !== approved[part]);
}
