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
 * - Executables: every file directly in `bin/`, which Claude Code adds to the
 *   Bash tool's `PATH`. A name there can shadow a command the agent runs, so the
 *   names are what is disclosed.
 *
 * Every file is read through {@link readDeclarationJson}, so nothing outside the
 * package is opened, and a declaration that cannot be read is reported rather
 * than dropped: "declares something we could not read" must never look like
 * "declares nothing".
 *
 * @module services/marketplace/lib/package-programs
 */
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PreviewLspServer,
  PreviewMcpServer,
  PreviewMonitor,
  UnreadableDeclaration,
  UnreadableDeclarationKind,
} from '../types.js';
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
  /** The file names in `bin/`, sorted. */
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

/** Every file (or link) directly in `bin/`; directories are not on `PATH`. */
async function readExecutables(packagePath: string): Promise<string[]> {
  const binDir = join(packagePath, EFFECT_BEARING_PATHS.executables);
  try {
    const stats = await lstat(binDir);
    if (!stats.isDirectory()) return [];
    const entries = await readdir(binDir, { withFileTypes: true });
    return entries
      .filter((e) => !e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
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
