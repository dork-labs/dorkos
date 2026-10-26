/**
 * What a person approves when they let an agent's own folder settings run
 * (DOR-3068): a digest of the three places an agent could hand itself more
 * power by rewriting a file in its home, each hashed on its own so a card can
 * say which one changed.
 *
 * - **`hooks`**: from `<home>/.claude/settings.json` and `settings.local.json`,
 *   only the keys that run code, sign in, or pick which MCP servers start
 *   ({@link CODE_SETTINGS_KEYS}); the CONTENTS of the scripts those commands
 *   run; and the `hooks` and `mcpServers` frontmatter of the home's subagents
 *   and skills (`folder-config-scripts.ts` says exactly which files).
 * - **`mcpJson`**: `<home>/.mcp.json`, whole.
 * - **`manifest`**: `<home>/.dork/agent.json`, only `id`, `runtime`,
 *   `mcpServers` and `account`. `id` so an agent can't look new by renaming
 *   itself, `runtime` so it can't move to a runtime this pin does not hold.
 *
 * **Not covered (the residual):** a file a hook script imports or sources; a
 * script a command names outside the home and the plugin folders (`~`, a
 * program on `PATH`, a variable); and Codex and OpenCode, which still pass an
 * agent's own MCP servers whatever this pin says. The agent's shell can still
 * edit any of those.
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
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { agentFileHooks, hookScriptFiles } from './folder-config-scripts.js';

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
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'otelHeadersHelper',
  'env',
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

/** The `hooks` part: the code-running keys of both settings files, the scripts they run, and agent-file hooks. */
function hooksPart(home: string, dorkHome: string): PartValue {
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
  const files = hookScriptFiles(home, commands, dorkHome);
  const agentFiles = agentFileHooks(home);
  if (files === undefined || agentFiles === undefined) {
    return { value: { ...value, files: { unverifiable: true } }, verifiable: false };
  }
  return { value: { ...value, files, agentFiles }, verifiable };
}

/** Settings keys whose string value is itself a command DorkOS runs. */
const HELPER_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'];

/** Every string `command` anywhere under a parsed settings slice, and each helper command. */
function collectCommands(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectCommands(item, out);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'command' || HELPER_KEYS.includes(key)) && typeof child === 'string') {
      out.push(child);
    } else {
      collectCommands(child, out);
    }
  }
}

/** The `mcpJson` part: the whole `.mcp.json`. */
function mcpJsonPart(home: string): PartValue {
  const read = readJsonFile(path.join(home, '.mcp.json'));
  if (read.kind === 'unverifiable') return { value: { unverifiable: true }, verifiable: false };
  if (read.kind === 'malformed') return { value: malformed(read.text), verifiable: true };
  return { value: read.kind === 'parsed' ? read.value : null, verifiable: true };
}

/** The `manifest` part: the agent file's `id`, `runtime`, `mcpServers` and `account`. */
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
      id: Object.hasOwn(fields, 'id') ? fields.id : null,
      runtime: Object.hasOwn(fields, 'runtime') ? fields.runtime : null,
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
 * @param dorkHome - DorkOS's data folder, whose `plugins/` installed hooks run from.
 */
export function readFolderConfigParts(
  home: string,
  dorkHome: string = resolveDorkHome()
): FolderConfigParts {
  const values: Record<FolderConfigPart, PartValue> = {
    hooks: hooksPart(home, dorkHome),
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
