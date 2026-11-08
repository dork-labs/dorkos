/**
 * The protected targets Codex needs to exist in an agent home before it will
 * edit there on Linux (DOR-3914). DorkOS keeps every agent's file tools off
 * these paths (`AGENT_HOME_SELF_GRANT_PATHS`). On Linux, Codex's sandbox
 * (bwrap) refuses a path by mounting over it, and a path that does not exist
 * has nothing to mount over: Codex would make a stand-in on the real disk
 * instead, so DorkOS refuses Edit and Full while one is missing
 * (`codex/policy/writable-missing-targets.ts`). These files and folders are
 * that protection's anchors, not clutter: deleting one brings the refusal back.
 *
 * The rules (Security, DOR-3914):
 * - Only homes DorkOS owns: a real folder directly under `{dorkHome}/agents`.
 *   A git repo there is somebody's repo and is left alone, like any folder
 *   elsewhere a person registered as an agent.
 * - The server calls it, at creation and in the repair at start. Never a turn.
 * - Create only, never through a link. Each folder between the home and a
 *   target must be a real folder whose real path stays in the home. Folders
 *   are a non-recursive mkdir; files are opened `O_CREAT|O_EXCL|O_NOFOLLOW`
 *   with fixed content. Anything already there, even empty or malformed, is
 *   left alone; a link is logged.
 *
 * @module services/core/agent-home/agent-home-scaffold
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveAgentsHome } from '../../../lib/agents-home.js';
import { logger } from '../../../lib/logger.js';

/** The fixed text a scaffolded `.mcp.json` holds: no servers. */
export const EMPTY_MCP_JSON = '{"mcpServers":{}}';

/** The fixed text a scaffolded Claude Code settings file holds: no settings. */
export const EMPTY_SETTINGS_JSON = '{}';

/** One target: a folder, or a file with its fixed content. */
export interface ScaffoldTarget {
  /** Path inside the home, `/`-separated. */
  rel: string;
  /** A folder, or a file with this exact content. */
  content: 'folder' | string;
}

/**
 * Every target, parents before children. Matches the agent-home entries of
 * `AGENT_HOME_SELF_GRANT_PATHS` that DorkOS does not already write itself
 * (`.claude/skills` and `.dork/agent.json` come with every agent).
 */
export const SCAFFOLD_TARGETS: readonly ScaffoldTarget[] = [
  { rel: '.agents', content: 'folder' },
  { rel: '.mcp.json', content: EMPTY_MCP_JSON },
  { rel: '.claude', content: 'folder' },
  { rel: '.claude/agents', content: 'folder' },
  { rel: '.claude/commands', content: 'folder' },
  { rel: '.claude/settings.json', content: EMPTY_SETTINGS_JSON },
  { rel: '.claude/settings.local.json', content: EMPTY_SETTINGS_JSON },
];

/**
 * What happened at one target: made now, already there, a link at it or
 * above it (left alone and logged), or a non-folder above it.
 */
export type ScaffoldOutcome = 'created' | 'kept' | 'refused-link' | 'blocked';

/** What happened in one home, or why it was skipped. */
export type HomeScaffoldResult =
  | { scaffolded: true; outcomes: Record<string, ScaffoldOutcome> }
  | { scaffolded: false; reason: 'not-owned' | 'repo' | 'linked' | 'error' };

/** The real path of the agents folder, or `undefined` when it does not exist. */
function realAgentsHome(): string | undefined {
  try {
    return fs.realpathSync(resolveAgentsHome());
  } catch {
    return undefined;
  }
}

/** What is at `target` already: a link, something else, or nothing. */
function present(target: string): 'refused-link' | 'kept' | undefined {
  try {
    return fs.lstatSync(target).isSymbolicLink() ? 'refused-link' : 'kept';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Whether every folder between `home` and `rel`'s parent is a real folder,
 * not a link, whose real path is exactly where it sits inside the home.
 */
function parentsSafe(home: string, rel: string): ScaffoldOutcome | undefined {
  let at = home;
  for (const segment of rel.split('/').slice(0, -1)) {
    at = path.join(at, segment);
    const stat = fs.lstatSync(at, { throwIfNoEntry: false });
    if (!stat) return 'blocked';
    if (stat.isSymbolicLink() || fs.realpathSync(at) !== at) return 'refused-link';
    if (!stat.isDirectory()) return 'blocked';
  }
  return undefined;
}

/** A folder: a non-recursive mkdir, never over anything already there. */
function makeFolder(target: string): ScaffoldOutcome {
  try {
    fs.mkdirSync(target); // Never follows a leaf link: one there is EEXIST.
    return 'created';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return present(target) ?? 'kept';
  }
}

/** A file: exclusive create with no link followed, fixed content. */
function makeFile(target: string, content: string): ScaffoldOutcome {
  let fd: number;
  try {
    // O_NOFOLLOW is undefined on Windows and ORs to 0 there; O_EXCL still
    // refuses any existing entry, links included, and the lstat before ran first.
    const { O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY } = fs.constants;
    fd = fs.openSync(target, O_CREAT | O_EXCL | O_NOFOLLOW | O_WRONLY, 0o644);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Something arrived between the look and the open: it is left alone.
    if (code === 'EEXIST' || code === 'ELOOP') return present(target) ?? 'kept';
    throw error;
  }
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  return 'created';
}

/** One target in a home already checked as owned and real. */
function scaffoldTarget(home: string, { rel, content }: ScaffoldTarget): ScaffoldOutcome {
  const parents = parentsSafe(home, rel);
  if (parents) return parents;
  const target = path.join(home, ...rel.split('/'));
  const already = present(target);
  if (already) return already;
  return content === 'folder' ? makeFolder(target) : makeFile(target, content);
}

/**
 * Add the missing {@link SCAFFOLD_TARGETS} to one agent home DorkOS owns.
 * Never throws; a home it does not own, a repo and a linked home are skipped
 * untouched.
 *
 * @param home - The agent's folder.
 * @returns What it did at each target, or why it skipped the home.
 */
export function scaffoldAgentHome(home: string): HomeScaffoldResult {
  try {
    const agents = realAgentsHome();
    const resolved = path.resolve(home);
    const parent = path.dirname(resolved);
    if (!agents || (parent !== agents && parent !== path.resolve(resolveAgentsHome())))
      return { scaffolded: false, reason: 'not-owned' };
    // The home's real path first: a linked home, or one whose real path leaves
    // the agents folder, is never written into. Accepted residual: a folder
    // swapped for a link between a check and its create could receive an empty
    // folder or fixed file; nothing is overwritten or read.
    const real = path.join(agents, path.basename(resolved));
    if (fs.lstatSync(real).isSymbolicLink() || fs.realpathSync(real) !== real) {
      logger.warn('[agents] Left a linked agent home alone', { home: resolved });
      return { scaffolded: false, reason: 'linked' };
    }
    if (!fs.statSync(real).isDirectory()) return { scaffolded: false, reason: 'not-owned' };
    if (present(path.join(real, '.git'))) return { scaffolded: false, reason: 'repo' };
    const outcomes: Record<string, ScaffoldOutcome> = {};
    for (const target of SCAFFOLD_TARGETS) {
      const outcome = scaffoldTarget(real, target);
      outcomes[target.rel] = outcome;
      if (outcome === 'refused-link')
        logger.warn('[agents] Left a link in an agent home alone', {
          path: path.join(real, ...target.rel.split('/')),
        });
    }
    return { scaffolded: true, outcomes };
  } catch (error) {
    logger.warn("[agents] Could not add Codex's protected files to an agent home", {
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
    created += Object.values(result.outcomes).filter((outcome) => outcome === 'created').length;
  }
  if (created > 0)
    logger.info("[agents] Added Codex's missing protected files to agent homes", { created });
  return created;
}
