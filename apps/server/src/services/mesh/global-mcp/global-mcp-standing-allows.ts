/**
 * Who may use a global MCP server without asking (DOR-4118).
 *
 * An "Always allow" on an MCP tool's card is a rule in the agent's own folder,
 * `.claude/settings.local.json` (`keepAlwaysAllowToAgent`), or one a person put
 * in `.claude/settings.json`. A bare `mcp__{server}` rule covers every tool the
 * server has, including ones it adds later; `mcp__{server}__{tool}` covers one.
 * This reads those rules back for one server, across every registered agent, so
 * the server's sheet can list them. It is not a new store, and it reads only
 * what the launch would pass (`judgeAllowRule`).
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
 * @param rule - A rule the launch would keep.
 * @param server - The global server's name.
 */
export function standingAllowBreadth(
  rule: string,
  server: string
): { breadth: 'server' } | { breadth: 'tool'; tool: string } | null {
  const bare = `mcp__${server}`;
  if (rule === bare) return { breadth: 'server' };
  if (!rule.startsWith(`${bare}__`)) return null;
  const tool = rule.slice(bare.length + 2);
  // A tool name never holds `__` or a pattern; anything else names another server's tool.
  if (!tool || tool.includes('__') || tool.includes('(')) return null;
  return { breadth: 'tool', tool };
}

/**
 * Every standing yes any of `agents` holds for `server`, in agent order.
 *
 * @param server - The global server's name.
 * @param agents - The registered agents to look in.
 */
export async function readStandingAllows(
  server: string,
  agents: readonly StandingAllowAgent[]
): Promise<StandingAllow[]> {
  const found: StandingAllow[] = [];
  for (const agent of agents) {
    const seen = new Set<string>();
    for (const file of FILES) {
      const entries = (await readFolderAllowEntries(agent.home, file)) ?? [];
      for (const entry of entries) {
        const verdict = judgeAllowRule(entry);
        if (!verdict.ok || seen.has(verdict.rule)) continue;
        const reach = standingAllowBreadth(verdict.rule, server);
        if (reach === null) continue;
        seen.add(verdict.rule);
        found.push({
          agentId: agent.id,
          agentName: agent.name,
          rule: verdict.rule,
          file,
          ...reach,
        });
      }
    }
  }
  return found;
}
