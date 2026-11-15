/**
 * Who may use a global MCP server without asking (DOR-4118).
 *
 * An "Always allow" on an MCP tool's card is a rule in the agent's own folder,
 * `.claude/settings.local.json` (`keepAlwaysAllowToAgent`), or one a person put
 * in `.claude/settings.json`. A bare `mcp__{server}` rule covers every tool the
 * server has, including ones it adds later; `mcp__{server}__{tool}` covers one.
 * This reads those rules back for one server, across every registered agent, so
 * the server's sheet can list them. It is not a new store, and it reads only
 * what the launch would pass (`judgeAllowRule`), plus `mcp__{server}__*`.
 *
 * @module services/mesh/global-mcp/global-mcp-standing-allows
 */
import {
  judgeAllowRule,
  readFolderAllowEntries,
} from '../../runtimes/claude-code/folder-settings/agent-folder-allows.js';

/** The settings files a standing yes can live in. Undo reaches only the local one. */
export type StandingAllowFile = 'settings.json' | 'settings.local.json';

/** One agent the reader looks in. */
export interface StandingAllowAgent {
  /** The agent's id. */
  id: string;
  /** What the agent is called. */
  name: string;
  /** The registered agent home, whose `.claude/` holds the rules. */
  home: string;
}

/** One standing yes for a server. */
export interface StandingAllow {
  /** The agent the rule belongs to. */
  agentId: string;
  /** What that agent is called. */
  agentName: string;
  /** The rule exactly as the file holds it. */
  rule: string;
  /** `server` for every tool, new ones included; `tool` for one. */
  breadth: 'server' | 'tool';
  /** The one tool, when `breadth` is `tool`. */
  tool?: string;
  /** Which file holds it. */
  file: StandingAllowFile;
}

/** The files read, in Claude Code's order. */
const FILES: readonly StandingAllowFile[] = ['settings.json', 'settings.local.json'];

/**
 * What one rule allows on `server`, or `null` when it is not about that server.
 *
 * `mcp__{server}__*` is the whole server too, the same as the bare rule
 * (DOR-4240). A server's name may hold `__`, so `mcp__a__b` can be server
 * `a__b`'s whole-server rule rather than tool `b` on `a`: when another known
 * server's name starts `{server}__`, a rule that names it is left to it.
 *
 * @param rule - A rule the launch would keep.
 * @param server - The global server's name.
 * @param servers - Every global server's name, to tell those apart.
 */
export function standingAllowBreadth(
  rule: string,
  server: string,
  servers: readonly string[] = []
): { breadth: 'server' } | { breadth: 'tool'; tool: string } | null {
  const bare = `mcp__${server}`;
  if (rule === bare || rule === `${bare}__*`) return { breadth: 'server' };
  if (!rule.startsWith(`${bare}__`)) return null;
  const longer = servers.some(
    (other) =>
      other.startsWith(`${server}__`) &&
      (rule === `mcp__${other}` || rule.startsWith(`mcp__${other}__`))
  );
  if (longer) return null;
  const tool = rule.slice(bare.length + 2);
  // A tool name never holds `__` or a pattern; anything else names another server's tool.
  if (!tool || tool.includes('__') || tool.includes('(') || tool.includes('*')) return null;
  return { breadth: 'tool', tool };
}

/**
 * The rule an entry holds, if the launch keeps it, or if it is exactly
 * `mcp__{server}__*`: the launch's own list drops a wildcard, but Claude Code
 * reads the settings file itself and honours that one (DOR-4240).
 */
function ruleOf(entry: unknown, server: string): string | undefined {
  const verdict = judgeAllowRule(entry);
  if (verdict.ok) return verdict.rule;
  const wildcard = `mcp__${server}__*`;
  return typeof entry === 'string' && entry.trim() === wildcard ? wildcard : undefined;
}

/**
 * Every standing yes any of `agents` holds for `server`, in agent order.
 *
 * @param server - The global server's name.
 * @param agents - The registered agents to look in.
 * @param servers - Every global server's name, so a server whose name holds
 *   `__` stays off a shorter server's sheet.
 */
export async function readStandingAllows(
  server: string,
  agents: readonly StandingAllowAgent[],
  servers: readonly string[] = []
): Promise<StandingAllow[]> {
  const found: StandingAllow[] = [];
  for (const agent of agents) {
    const seen = new Set<string>();
    for (const file of FILES) {
      const entries = (await readFolderAllowEntries(agent.home, file)) ?? [];
      for (const entry of entries) {
        const rule = ruleOf(entry, server);
        if (rule === undefined || seen.has(rule)) continue;
        const reach = standingAllowBreadth(rule, server, servers);
        if (reach === null) continue;
        seen.add(rule);
        found.push({ agentId: agent.id, agentName: agent.name, rule, file, ...reach });
      }
    }
  }
  return found;
}
