/**
 * What a project's own OpenCode config would have added, counted by DorkOS,
 * now that the shared sidecar loads none of it (DOR-4394, DOR-4404).
 *
 * The sidecar runs with `OPENCODE_DISABLE_PROJECT_CONFIG`, so a project's
 * plugins, tools and MCP servers stay off. Nothing should be lost silently, so
 * the chat says how many were kept off. This is DorkOS's own record of what it
 * withheld: it counts, and never passes on a name, a path or any other text a
 * project wrote (Security's rule).
 *
 * What it counts, in each folder from the project's top down to the session's
 * own (the walk `project-instructions.ts` uses for `AGENTS.md`):
 *
 * - plugins: each `.opencode/plugin/` or `.opencode/plugins/` code file, and
 *   each entry in a config file's `plugin` list;
 * - tools: each `.opencode/tool/` or `.opencode/tools/` code file;
 * - MCP servers: each key of a config file's `mcp` object.
 *
 * The config files are `opencode.json`, `opencode.jsonc` and the same two
 * inside `.opencode/`. A file over the size cap, or one that will not parse,
 * adds nothing: the count stays an honest floor.
 *
 * @module services/runtimes/opencode/messaging/withheld-project-addons
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { openCodeProjectChain } from './project-instructions.js';

/** How many of each kind of project add-on DorkOS kept off. */
export interface WithheldProjectAddons {
  /** Plugin files and `plugin` list entries. */
  plugins: number;
  /** Custom tool files. */
  tools: number;
  /** MCP servers named in a config file. */
  mcpServers: number;
}

/** The largest config file read. A real one is a few kilobytes. */
const MAX_CONFIG_BYTES = 256 * 1024;

/** The code files OpenCode loads from a plugin or tool folder. */
const CODE_FILE = /\.(?:[cm]?js|[cm]?ts)$/;

/** The config file names OpenCode reads in a folder and in its `.opencode/`. */
const CONFIG_NAMES = ['opencode.json', 'opencode.jsonc'];

/** How many code files sit directly in `dir`; none when it is absent or unreadable. */
function codeFiles(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(
      (entry) => (entry.isFile() || entry.isSymbolicLink()) && CODE_FILE.test(entry.name)
    ).length;
  } catch {
    return 0;
  }
}

/**
 * JSONC as plain JSON: comments and trailing commas removed, strings left as
 * they are.
 */
function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') {
      const start = i;
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === '\\') i += 1;
      out += text.slice(start, i + 1);
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) break;
      i += 1;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** A config file's `plugin` and `mcp` counts; nothing when it is absent, too big or unparseable. */
function configCounts(file: string): { plugins: number; mcpServers: number } {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return { plugins: 0, mcpServers: 0 };
    const config: unknown = JSON.parse(stripJsonc(readFileSync(file, 'utf8')));
    if (typeof config !== 'object' || config === null) return { plugins: 0, mcpServers: 0 };
    const { plugin, mcp } = config as { plugin?: unknown; mcp?: unknown };
    return {
      plugins: Array.isArray(plugin) ? plugin.length : 0,
      mcpServers:
        typeof mcp === 'object' && mcp !== null && !Array.isArray(mcp)
          ? Object.keys(mcp).length
          : 0,
    };
  } catch {
    return { plugins: 0, mcpServers: 0 };
  }
}

/**
 * Count what the project's own OpenCode config would have added.
 *
 * Never throws.
 *
 * @param directory - The session's folder.
 * @returns The counts, or `undefined` when the project adds nothing.
 */
export function withheldProjectAddons(directory: string): WithheldProjectAddons | undefined {
  const counts: WithheldProjectAddons = { plugins: 0, tools: 0, mcpServers: 0 };
  for (const dir of openCodeProjectChain(directory)) {
    const dotDir = path.join(dir, '.opencode');
    counts.plugins +=
      codeFiles(path.join(dotDir, 'plugin')) + codeFiles(path.join(dotDir, 'plugins'));
    counts.tools += codeFiles(path.join(dotDir, 'tool')) + codeFiles(path.join(dotDir, 'tools'));
    for (const base of [dir, dotDir]) {
      for (const name of CONFIG_NAMES) {
        const found = configCounts(path.join(base, name));
        counts.plugins += found.plugins;
        counts.mcpServers += found.mcpServers;
      }
    }
  }
  return counts.plugins + counts.tools + counts.mcpServers > 0 ? counts : undefined;
}
