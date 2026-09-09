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
 * nothing a count cannot say that a name would need to.
 *
 * The boundary is what LEAVES these readers, not how little they parse. Both
 * parse the whole file — `JSON.parse`, and smol-toml for Codex — and hand back
 * one number, because the number is the only thing a caller is given. An earlier
 * version tried to be safe by parsing LESS, matching TOML table headers with a
 * regex; it got three of five ordinary spellings wrong, two of them as silent
 * zeros. Two consequences of parsing properly are load-bearing and both are
 * tested: a parse error's own message never travels (both parsers quote the
 * offending text back, and the offending text in one of these files is somebody's
 * key), and a leading byte-order mark is stripped before either parse, because a
 * file a Windows editor saved is not an unreadable file.
 *
 * @module inventory/foreign-mcp
 */
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { nothingIsThere, readTextFile } from './read.js';
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

/** The repo-relative config file Codex reads MCP servers from. */
const CODEX_CONFIG_SOURCE = '.codex/config.toml';

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
 * The byte-order mark a Windows editor leaves at the front of a UTF-8 file.
 *
 * Neither parser accepts one, and `readFile` does not strip it, so a
 * `.cursor/mcp.json` saved by Notepad came back "not valid JSON" — a file plainly
 * full of MCP servers reported as unreadable.
 */
const BOM = '\ufeff';

/**
 * A file's text without its byte-order mark, if it has one.
 *
 * @param text - the file's contents as read.
 * @returns the same text, BOM removed.
 */
function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/**
 * Count the keys of one top-level table, and nothing below them.
 *
 * `Object.keys(...).length` is the whole read: the values are never touched, so
 * an `env` block cannot reach a caller by any route.
 *
 * @param servers - the value found under the servers key.
 * @param label - the file's name, for the reason on a failure.
 * @param wrongShape - what the file has instead, in that file's own vocabulary:
 *   JSON has objects and TOML has tables, and a person reading a line about
 *   their `.codex/config.toml` should not be told it has the wrong kind of
 *   object.
 * @returns the count, or why there is none.
 */
function countTableKeys(servers: unknown, label: string, wrongShape: string): CountResult {
  if (servers === undefined) return {};
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    return {
      unreadable: `${label} has ${wrongShape}, so DorkOS could not count the MCP servers in it`,
    };
  }
  return { servers: Object.keys(servers).length };
}

/**
 * Count the servers under one top-level key of a JSON file.
 *
 * @param key - the top-level key the servers sit under.
 * @param label - the file's name, for the reason on a failure.
 * @returns a counter for {@link ForeignMcpShape.count}.
 */
function countJsonServers(key: string, label: string): (text: string) => CountResult {
  return (text) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripBom(text));
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
    return countTableKeys(
      (parsed as Record<string, unknown>)[key],
      label,
      `a "${key}" key that is not an object`
    );
  };
}

/**
 * Count the servers a `.codex/config.toml` declares under `[mcp_servers]`.
 *
 * A real TOML parse, because the same servers have five ordinary spellings and a
 * header-matching regex got three of them wrong — two of those as SILENT ZEROS,
 * which is the exact silence this module exists to end, reintroduced one file
 * deeper. A comment after the header (`[mcp_servers.alpha] # note`) missed the
 * end-of-line anchor; inline tables under one `[mcp_servers]` and dotted keys
 * (`mcp_servers.alpha.command = "npx"`) have no per-server header to match at
 * all; and two QUOTED names sharing a dotted prefix collapsed into one. All five
 * spellings are `CODEX_TOML_SHAPES` in `__tests__/inventory.test.ts`.
 *
 * The parser hands back every value in the file and none of them is looked at:
 * only `Object.keys` of the `mcp_servers` table leaves this function, and the
 * parse error's message is dropped rather than carried, because smol-toml prints
 * the offending LINE back and the offending line in one of these files is
 * somebody's API key.
 *
 * @param text - the file's contents.
 * @returns the number of servers, or why there is none.
 */
function countCodexServers(text: string): CountResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(stripBom(text));
  } catch {
    return {
      unreadable: `${CODEX_CONFIG_SOURCE} is not valid TOML, so DorkOS could not read what it declares`,
    };
  }
  return countTableKeys(
    parsed['mcp_servers'],
    CODEX_CONFIG_SOURCE,
    'an mcp_servers key that is not a table'
  );
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
    source: CODEX_CONFIG_SOURCE,
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
    // Not `lstatSync(…, { throwIfNoEntry: false })`: that suppresses ENOENT only,
    // so a plain FILE at `.codex` threw ENOTDIR out of here and took `project()`
    // down — the shape DOR-1882 closed for every other reader. Something in the
    // way becomes the finding `readTextFile` writes, never a throw.
    if (nothingIsThere(abs)) continue;
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
