/**
 * Read the programs a Claude Code plugin starts on its own, for the permission
 * preview: MCP servers, language (LSP) servers, background monitors, and the
 * executables it puts on the agent's `PATH`.
 *
 * Each is something Claude Code runs without anyone asking for it by name once
 * the plugin is loaded (for a global DorkOS install, into every session:
 * `plugin-activation.ts`), so each is part of what an install or an update asks
 * a person to approve (DOR-647, DOR-2195). The shapes follow the Claude Code
 * plugins reference:
 *
 * - MCP servers: `.mcp.json`, or plugin.json `mcpServers`, each a map of
 *   `name → { command, args } | { type, url }`, optionally wrapped in
 *   `{ mcpServers: … }`.
 * - LSP servers: `.lsp.json`, or plugin.json `lspServers`, each a map of
 *   `name → { command, args?, extensionToLanguage, … }`.
 * - Monitors: `monitors/monitors.json`, or plugin.json `experimental.monitors`
 *   (also accepted at the top level), an array of `{ name, command, when? }`.
 * - Executables: every program directly in `bin/` (by permission, not name:
 *   {@link isPathProgram}), which Claude Code adds to the Bash tool's `PATH`.
 *   A name there can shadow a command the agent runs, so the names are what is
 *   disclosed.
 *
 * Every file is read through {@link readDeclarationJson}, so nothing outside the
 * package is opened, and a declaration that cannot be read is reported rather
 * than dropped: "declares something we could not read" must never look like
 * "declares nothing".
 *
 * @module services/marketplace/lib/declarations/package-programs
 */
import { lstat, open, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type {
  PreviewLspServer,
  PreviewMcpServer,
  PreviewMonitor,
  UnreadableDeclaration,
  UnreadableDeclarationKind,
} from '../../types.js';
import {
  declarationsOf,
  isRecord,
  readDeclarationJson,
  type DeclarationSource,
} from './package-declarations.js';
import { EFFECT_BEARING_PATHS } from '@dorkos/marketplace';

/** What {@link readPackagePrograms} found. */
export interface PackagePrograms {
  /** Every readable MCP server, sorted by name. */
  mcpServers: PreviewMcpServer[];
  /** Every readable language server, sorted by name. */
  lspServers: PreviewLspServer[];
  /** Every readable monitor, sorted by name. */
  monitors: PreviewMonitor[];
  /** The names of the programs in `bin/`, sorted. */
  executables: string[];
  /** Every declaration, or entry, that could not be read. */
  unreadable: UnreadableDeclaration[];
}

/** String arguments, verbatim and in order; anything else is dropped. */
function argsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((a): a is string => typeof a === 'string') : [];
}

/**
 * Resolve every source of one kind to its parsed values, reporting the ones that
 * cannot be read.
 */
async function valuesOf(
  packagePath: string,
  sources: DeclarationSource[],
  kind: UnreadableDeclarationKind,
  unreadable: UnreadableDeclaration[]
): Promise<{ path: string; value: unknown }[]> {
  const values: { path: string; value: unknown }[] = [];
  for (const source of sources) {
    if (source.kind === 'inline') {
      values.push({ path: source.path, value: source.value });
      continue;
    }
    const read = await readDeclarationJson(packagePath, source.path);
    if (read.kind === 'ok') values.push({ path: source.path, value: read.value });
    else if (read.kind === 'unreadable' || source.required) {
      unreadable.push({ path: source.path, kind });
    }
  }
  return values;
}

/** A server map, unwrapped from `{ [wrapper]: … }` when it is wrapped. */
function serverMap(value: unknown, wrapper: string): Record<string, unknown> | undefined {
  const map = isRecord(value) && wrapper in value ? value[wrapper] : value;
  return isRecord(map) ? map : undefined;
}

/** Read the MCP servers. */
async function readMcpServers(
  packagePath: string,
  field: unknown,
  unreadable: UnreadableDeclaration[]
): Promise<PreviewMcpServer[]> {
  const servers: PreviewMcpServer[] = [];
  const sources = declarationsOf(EFFECT_BEARING_PATHS.mcpServersFile, field);
  for (const { path, value } of await valuesOf(packagePath, sources, 'mcp-server', unreadable)) {
    const map = serverMap(value, 'mcpServers');
    if (!map) {
      unreadable.push({ path, kind: 'mcp-server' });
      continue;
    }
    for (const [name, entry] of Object.entries(map)) {
      const declared = isRecord(entry) && typeof entry.type === 'string' ? entry.type : undefined;
      if (
        isRecord(entry) &&
        typeof entry.command === 'string' &&
        (declared === undefined || declared === 'stdio')
      ) {
        servers.push({
          name,
          transport: 'stdio',
          command: entry.command,
          args: argsOf(entry.args),
        });
      } else if (isRecord(entry) && typeof entry.url === 'string') {
        servers.push({ name, transport: declared ?? 'http', url: entry.url });
      } else {
        unreadable.push({ path, kind: 'mcp-server', entry: name });
      }
    }
  }
  return servers.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read the language servers. */
async function readLspServers(
  packagePath: string,
  field: unknown,
  unreadable: UnreadableDeclaration[]
): Promise<PreviewLspServer[]> {
  const servers: PreviewLspServer[] = [];
  const sources = declarationsOf(EFFECT_BEARING_PATHS.lspServersFile, field);
  for (const { path, value } of await valuesOf(packagePath, sources, 'lsp-server', unreadable)) {
    const map = serverMap(value, 'lspServers');
    if (!map) {
      unreadable.push({ path, kind: 'lsp-server' });
      continue;
    }
    for (const [name, entry] of Object.entries(map)) {
      if (isRecord(entry) && typeof entry.command === 'string' && entry.command.length > 0) {
        servers.push({ name, command: entry.command, args: argsOf(entry.args) });
      } else {
        unreadable.push({ path, kind: 'lsp-server', entry: name });
      }
    }
  }
  return servers.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read the monitors. */
async function readMonitors(
  packagePath: string,
  pluginJson: Record<string, unknown> | undefined,
  unreadable: UnreadableDeclaration[]
): Promise<PreviewMonitor[]> {
  const experimental = isRecord(pluginJson?.experimental) ? pluginJson.experimental : undefined;
  const field = experimental?.monitors ?? pluginJson?.monitors;
  const monitors: PreviewMonitor[] = [];
  const sources = declarationsOf(EFFECT_BEARING_PATHS.monitorsFile, field);
  for (const { path, value } of await valuesOf(packagePath, sources, 'monitor', unreadable)) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (isRecord(entry) && typeof entry.command === 'string' && entry.command.length > 0) {
        const name = typeof entry.name === 'string' ? entry.name : entry.command;
        monitors.push({
          name,
          command: entry.command,
          ...(typeof entry.when === 'string' && { when: entry.when }),
        });
      } else {
        const name = isRecord(entry) && typeof entry.name === 'string' ? entry.name : undefined;
        unreadable.push({ path, kind: 'monitor', ...(name && { entry: name }) });
      }
    }
  }
  return monitors.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Extensions Windows runs as programs without being told how (`PATHEXT`'s
 * defaults that a shell resolves bare names to).
 */
const WINDOWS_PROGRAM_EXTENSIONS = new Set(['.exe', '.com', '.bat', '.cmd']);

/**
 * Whether the entry at `abs` would run as a command from `PATH` (DOR-2340).
 *
 * Decided by what the system itself checks, never by name, so a saved copy
 * whose execute bits were cleared (`tool.dork-old`) stops being disclosed as a
 * program for the same reason it stops being one.
 *
 * - **POSIX:** any execute bit. A link counts: its own mode says nothing, and
 *   following it could leave the package, so it is disclosed rather than read.
 * - **Windows:** there are no execute bits (Node reports none on any file), so
 *   this mirrors how the Git Bash that Claude Code's Bash tool runs in decides:
 *   a file ending `.exe`, `.com`, `.bat` or `.cmd`, or one starting with `#!`
 *   (a script) or `MZ` (a program). A link counts, as on POSIX.
 *
 * @param abs - The entry, directly in `bin/`.
 * @param platform - The system deciding.
 */
export async function isPathProgram(
  abs: string,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  const stats = await lstat(abs);
  if (stats.isSymbolicLink()) return true;
  if (!stats.isFile()) return false;
  if (platform !== 'win32') return (stats.mode & 0o111) !== 0;
  if (WINDOWS_PROGRAM_EXTENSIONS.has(extname(abs).toLowerCase())) return true;
  const handle = await open(abs, 'r');
  try {
    const head = Buffer.alloc(2);
    const { bytesRead } = await handle.read(head, 0, 2, 0);
    const magic = head.subarray(0, bytesRead).toString('latin1');
    return magic === '#!' || magic === 'MZ';
  } finally {
    await handle.close();
  }
}

/**
 * Every entry directly in `bin/` that runs as a command from `PATH`
 * ({@link isPathProgram}); directories are not on `PATH`, and a file that
 * cannot be read is disclosed rather than hidden.
 */
async function readExecutables(
  packagePath: string,
  platform: NodeJS.Platform = process.platform
): Promise<string[]> {
  const binDir = join(packagePath, EFFECT_BEARING_PATHS.executables);
  let names: string[];
  try {
    const stats = await lstat(binDir);
    if (!stats.isDirectory()) return [];
    const entries = await readdir(binDir, { withFileTypes: true });
    names = entries.filter((e) => !e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const programs: string[] = [];
  for (const name of names) {
    const counts = await isPathProgram(join(binDir, name), platform).catch(() => true);
    if (counts) programs.push(name);
  }
  return programs.sort();
}

/**
 * Every program the package at `packagePath` starts on its own.
 *
 * @param packagePath - Absolute path to the staged package.
 * @param pluginJson - The package's plugin.json, when it has a readable one.
 * @returns The programs of each kind, and every declaration that could not be read.
 */
export async function readPackagePrograms(
  packagePath: string,
  pluginJson: Record<string, unknown> | undefined
): Promise<PackagePrograms> {
  const unreadable: UnreadableDeclaration[] = [];
  const mcpServers = await readMcpServers(packagePath, pluginJson?.mcpServers, unreadable);
  const lspServers = await readLspServers(packagePath, pluginJson?.lspServers, unreadable);
  const monitors = await readMonitors(packagePath, pluginJson, unreadable);
  const executables = await readExecutables(packagePath);
  return { mcpServers, lspServers, monitors, executables, unreadable };
}
