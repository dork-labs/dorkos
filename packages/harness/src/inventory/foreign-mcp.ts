/**
 * The MCP config files that belong to another agent tool — the ones DorkOS
 * carries nothing out of, and used to say nothing about either (DOR-1902).
 *
 * `.mcp.json` is the file the engine knows (`./mcp.ts`, XA-03). It is not the
 * only place a repository declares MCP servers: an OpenCode project puts them in
 * `opencode.json` under `mcp`, a Codex project in `.codex/config.toml` under
 * `[mcp_servers.<name>]`, a Cursor project in `.cursor/mcp.json`. Each of those
 * was absent from every list `dorkos harness sync` prints — not dropped with a
 * reason, not warned about — which reads exactly like a repository that declares
 * no MCP servers at all.
 *
 * **This is a DROP, not something to adopt.** Nothing here is moved, linked or
 * rewritten: the engine projects no MCP server anywhere yet (XA-03), so the
 * honest thing to say about a `opencode.json` full of servers is that DorkOS
 * carries MCP servers from `.mcp.json` only. One entry per FILE, reported once
 * rather than once per harness, because the answer is the same for every harness
 * and six identical lines is noise.
 *
 * **A count, never a name and never a value.** `./mcp.ts` records the server
 * names in `.mcp.json` and states why it records nothing else: a real `env` block
 * holds live API keys, and this record is printed in a terminal, passed around
 * and served over an API. The same rule is stricter here, because there is
 * nothing a count cannot say that a name would need to. So each reader below
 * parses its file only far enough to count top-level server declarations, and
 * nothing inside one is ever read.
 *
 * @module inventory/foreign-mcp
 */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readTextFile } from './read.js';
import type { ForeignMcpConfig, UnreadableSource } from './types.js';

/**
 * The day the three shapes below were checked against their vendor's own
 * documentation.
 *
 * Its own constant, on the discipline `vendor-facts` and
 * `plan/source-artifacts.ts` both keep: a partial re-check of one kind must not
 * silently re-date another. Changing a `shape` here means re-opening that
 * vendor's page and moving this.
 */
export const FOREIGN_MCP_FACTS_FETCHED_AT = '2026-09-07';

/**
 * How many servers one file declares, or why that could not be answered.
 *
 * `servers: undefined` with no `unreadable` means the file is there and declares
 * no MCP servers at all — an `opencode.json` that only sets a theme, which is the
 * common case and stays silent.
 */
interface CountResult {
  /** The number of servers declared, absent when the file declares none. */
  servers?: number;
  /** Why the file could not be counted. */
  unreadable?: string;
}

/** One MCP config file another agent tool reads, and how its servers are counted. */
interface ForeignMcpShape {
  /** Repo-relative path, forward slashes. */
  source: string;
  /**
   * The tool whose own documentation names this file, and the key or table its
   * servers sit under — quoted in the unreadable reason so a person knows what
   * DorkOS was looking for.
   */
  declaredIn: string;
  /** Count the servers in the file's text, reading no value. */
  count: (text: string) => CountResult;
}

/**
 * Count the keys of one top-level object in a JSON file, and nothing below them.
 *
 * `Object.keys(...).length` is the whole read: the values are never touched, so
 * an `env` block cannot reach a caller by any route, including a thrown error's
 * message.
 *
 * @param key - the top-level key the servers sit under.
 * @param label - the file's name, for the reason on a failure.
 * @returns a counter for {@link ForeignMcpShape.count}.
 */
function countJsonServers(key: string, label: string): (text: string) => CountResult {
  return (text) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // The parse error's message is deliberately NOT carried. `JSON.parse`
      // quotes the text around the failure, and the text around a failure in one
      // of these files is somebody's API key.
      return {
        unreadable: `${label} is not valid JSON, so DorkOS could not read what it declares`,
      };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        unreadable: `${label} parses, but its top level is not an object, so DorkOS could not read what it declares`,
      };
    }
    const servers = (parsed as Record<string, unknown>)[key];
    if (servers === undefined) return {};
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
      return {
        unreadable: `${label} has a "${key}" key that is not an object, so DorkOS could not count the MCP servers in it`,
      };
    }
    return { servers: Object.keys(servers).length };
  };
}

/**
 * The TOML table header a Codex MCP server is declared under.
 *
 * A header match rather than a TOML parse, and that is the point: a parser would
 * hand back every value in the file, and this needs none of them. The pattern is
 * anchored to a whole line, so the only way to over-count is a line inside a
 * multi-line string that reads exactly like a table header — which costs a wrong
 * number in a sentence, and never a leaked value.
 */
const CODEX_MCP_TABLE = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(.+?)[ \t]*\][ \t]*$/gm;

/**
 * Count the `[mcp_servers.<name>]` tables in a `.codex/config.toml`.
 *
 * Distinct names, because TOML lets one server's keys be split over a table and
 * a sub-table (`[mcp_servers.linear]` then `[mcp_servers.linear.env]`) — the
 * sub-table would otherwise count as a second server. The `.env` suffix is not
 * special-cased: taking the name up to its first dot is what makes both spellings
 * one server.
 *
 * @param text - the file's contents.
 * @returns the number of distinct servers, or nothing when it declares none.
 */
function countCodexServers(text: string): CountResult {
  const names = new Set<string>();
  for (const match of text.matchAll(CODEX_MCP_TABLE)) {
    const declared =
      (match[1] ?? '')
        .split('.')[0]
        ?.trim()
        .replace(/^["']|["']$/g, '') ?? '';
    if (declared !== '') names.add(declared);
  }
  return names.size === 0 ? {} : { servers: names.size };
}

/**
 * The MCP config files DorkOS recognises and carries nothing out of.
 *
 * Each row is another tool's documented project-level MCP config, transcribed
 * from the same vendor pages `plan/source-artifacts.ts`'s `MCP_PLACEMENTS`
 * quotes and dated by {@link FOREIGN_MCP_FACTS_FETCHED_AT}. Gemini CLI's
 * `.gemini/settings.json` is deliberately absent: that file is a whole settings
 * document whose `mcpServers` key sits beside unrelated ones, and reading it to
 * count servers means opening somebody's editor settings — a bigger claim than
 * this list needs. Copilot's `.vscode/mcp.json` is absent for the same reason its
 * placement row says: which file Copilot reads depends on the surface, and one
 * row would be wrong for two of the three.
 */
const FOREIGN_MCP_SHAPES: readonly ForeignMcpShape[] = [
  {
    source: '.codex/config.toml',
    declaredIn: 'Codex keeps MCP servers here, under [mcp_servers.<name>]',
    count: countCodexServers,
  },
  {
    source: '.cursor/mcp.json',
    declaredIn: 'Cursor keeps MCP servers here',
    count: countJsonServers('mcpServers', '.cursor/mcp.json'),
  },
  {
    source: 'opencode.json',
    declaredIn: 'OpenCode keeps MCP servers here, under "mcp"',
    count: countJsonServers('mcp', 'opencode.json'),
  },
];

/**
 * Find every MCP config file in this tree that belongs to another agent tool.
 *
 * An absent file is silent, exactly as `.mcp.json` is: a repository with no
 * `opencode.json` has nothing to report. A file that is there and declares no
 * servers is silent too — most `opencode.json`s are a theme and a model. A file
 * that is there and cannot be read is reported, because it is plainly a config
 * somebody meant to work.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns one record per file that declares at least one server, and why any of
 *   them could not be read.
 */
export function inventoryForeignMcpConfigs(repoRoot: string): {
  foreignMcpConfigs: ForeignMcpConfig[];
  unreadable: UnreadableSource[];
} {
  const foreignMcpConfigs: ForeignMcpConfig[] = [];
  const unreadable: UnreadableSource[] = [];

  for (const shape of FOREIGN_MCP_SHAPES) {
    const abs = join(repoRoot, shape.source);
    if (lstatSync(abs, { throwIfNoEntry: false }) === undefined) continue;
    const read = readTextFile(abs, shape.source, 'mcp');
    if (read.text === undefined) {
      if (read.unreadable) unreadable.push(read.unreadable);
      continue;
    }
    const counted = shape.count(read.text);
    if (counted.unreadable !== undefined) {
      unreadable.push({
        kind: 'mcp',
        source: shape.source,
        reason: `${counted.unreadable} — ${shape.declaredIn} (vendor docs, ${FOREIGN_MCP_FACTS_FETCHED_AT})`,
      });
      continue;
    }
    if (counted.servers === undefined || counted.servers === 0) continue;
    foreignMcpConfigs.push({ source: shape.source, serverCount: counted.servers });
  }

  return { foreignMcpConfigs, unreadable };
}
