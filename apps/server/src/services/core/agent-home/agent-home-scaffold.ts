/**
 * The two protected targets Codex needs in an agent home before it will edit
 * there on Linux (DOR-3914): an `.agents/` folder and an `.mcp.json` file.
 * DorkOS pre-creates `.claude/` and `.dork/` itself; without these two, a
 * Codex turn at Edit refuses in a folder DorkOS made.
 *
 * The rules (Security, DOR-3914):
 * - Only homes DorkOS owns: a real folder directly under `{dorkHome}/agents`.
 *   A git repo there is somebody's repo and is left alone, like any folder
 *   elsewhere a person registered as an agent.
 * - The server calls it, at creation and in the repair at start. Never a turn.
 * - Create only. `.agents/` is a non-recursive mkdir; `.mcp.json` is opened
 *   `O_CREAT|O_EXCL|O_NOFOLLOW` with fixed content. The home's real path is
 *   checked first. Anything already there is left alone; a link is logged.
 *
 * @module services/core/agent-home/agent-home-scaffold
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveAgentsHome } from '../../../lib/agents-home.js';
import { logger } from '../../../lib/logger.js';

/** The fixed text a scaffolded `.mcp.json` holds: no servers. */
export const EMPTY_MCP_JSON = '{"mcpServers":{}}';

/** What happened at one target. */
export type ScaffoldOutcome = 'created' | 'kept' | 'refused-link';

/** What happened in one home, or why it was skipped. */
export type HomeScaffoldResult =
  | { scaffolded: true; agents: ScaffoldOutcome; mcpJson: ScaffoldOutcome }
  | { scaffolded: false; reason: 'not-owned' | 'repo' | 'linked' | 'error' };

/** The real path of the agents folder, or `undefined` when it does not exist. */
function realAgentsHome(): string | undefined {
  try {
    return fs.realpathSync(resolveAgentsHome());
  } catch {
    return undefined;
  }
}

/** Whether anything at all sits at `target`, a link included. */
function exists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** What is at `target` already: a link, something else, or nothing. */
function present(target: string): ScaffoldOutcome | undefined {
  try {
    return fs.lstatSync(target).isSymbolicLink() ? 'refused-link' : 'kept';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** `.agents/`: a non-recursive mkdir, never over anything already there. */
function scaffoldAgentsFolder(target: string): ScaffoldOutcome {
  const already = present(target);
  if (already) return already;
  try {
    fs.mkdirSync(target);
    return 'created';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return present(target) ?? 'kept';
  }
}

/** `.mcp.json`: exclusive create with no link followed, fixed content. */
function scaffoldMcpJson(target: string): ScaffoldOutcome {
  const already = present(target);
  if (already) return already;
  let fd: number;
  try {
    // O_NOFOLLOW is undefined on Windows and ORs to 0 there; O_EXCL still
    // refuses any existing entry, links included, and the lstat above ran first.
    const { O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY } = fs.constants;
    fd = fs.openSync(target, O_CREAT | O_EXCL | O_NOFOLLOW | O_WRONLY, 0o644);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Something arrived between the look and the open: it is left alone.
    if (code === 'EEXIST' || code === 'ELOOP') return present(target) ?? 'kept';
    throw error;
  }
  try {
    fs.writeSync(fd, EMPTY_MCP_JSON);
  } finally {
    fs.closeSync(fd);
  }
  return 'created';
}

/**
 * Add `.agents/` and `.mcp.json` to one agent home DorkOS owns. Never throws;
 * a home it does not own, a repo and a linked home are skipped untouched.
 *
 * @param home - The agent's folder.
 * @returns What it did, or why it skipped the home.
 */
export function scaffoldAgentHome(home: string): HomeScaffoldResult {
  try {
    const agents = realAgentsHome();
    const resolved = path.resolve(home);
    const parent = path.dirname(resolved);
    if (!agents || (parent !== agents && parent !== path.resolve(resolveAgentsHome())))
      return { scaffolded: false, reason: 'not-owned' };
    // The home's real path first: a linked home, or one whose real path leaves
    // the agents folder, is never written into. Accepted residual: a home swapped
    // for a link between this check and the create could receive an empty
    // `.agents/` or the fixed `.mcp.json`; nothing is overwritten or read.
    const real = path.join(agents, path.basename(resolved));
    if (fs.lstatSync(real).isSymbolicLink() || fs.realpathSync(real) !== real) {
      logger.warn('[agents] Left a linked agent home alone', { home: resolved });
      return { scaffolded: false, reason: 'linked' };
    }
    if (!fs.statSync(real).isDirectory()) return { scaffolded: false, reason: 'not-owned' };
    if (exists(path.join(real, '.git'))) return { scaffolded: false, reason: 'repo' };
    const result = {
      scaffolded: true as const,
      agents: scaffoldAgentsFolder(path.join(real, '.agents')),
      mcpJson: scaffoldMcpJson(path.join(real, '.mcp.json')),
    };
    for (const [name, outcome] of [
      ['.agents', result.agents],
      ['.mcp.json', result.mcpJson],
    ] as const) {
      if (outcome === 'refused-link')
        logger.warn('[agents] Left a link in an agent home alone', {
          path: path.join(real, name),
        });
    }
    return result;
  } catch (error) {
    logger.warn('[agents] Could not add .agents and .mcp.json to an agent home', {
      home,
      error: error instanceof Error ? error.message : String(error),
    });
    return { scaffolded: false, reason: 'error' };
  }
}

/** Whether `home` holds an agent file that is not a link. */
function isAgentHome(home: string): boolean {
  try {
    return fs.lstatSync(path.join(home, '.dork', 'agent.json')).isFile();
  } catch {
    return false;
  }
}

/**
 * The repair at start: scaffold every agent home DorkOS owns. Create only, so
 * a second run changes nothing. Never throws.
 *
 * @returns How many targets it created.
 */
export function repairAgentHomes(): number {
  const agents = realAgentsHome();
  if (!agents) return 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agents, { withFileTypes: true });
  } catch (error) {
    logger.warn('[agents] Could not list agent homes to repair', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
  let created = 0;
  for (const entry of entries) {
    // Only real folders that are agents; a link is skipped without following it.
    if (!entry.isDirectory()) continue;
    const home = path.join(agents, entry.name);
    if (!isAgentHome(home)) continue;
    const result = scaffoldAgentHome(home);
    if (!result.scaffolded) continue;
    created += Number(result.agents === 'created') + Number(result.mcpJson === 'created');
  }
  if (created > 0)
    logger.info('[agents] Added missing .agents and .mcp.json to agent homes', { created });
  return created;
}
