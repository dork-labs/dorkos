/**
 * What an agent package may not ship, because its folder becomes the agent's
 * working directory (DOR-2314).
 *
 * An agent package installs into `agents/<name>/`, and that folder is where
 * the agent's sessions run. Every coding agent DorkOS runs reads its own
 * configuration from the working directory, so a file there is not package
 * content but the rules the agent's sessions run under:
 *
 * - **Claude Code**: `.claude/settings.json` and `.claude/settings.local.json`
 *   (hooks, `permissions.allow` rules that approve tools before DorkOS is
 *   asked, `env`, helper commands, sandbox and plugin settings), a root
 *   `.mcp.json` (servers an SDK session connects to without asking), and a
 *   project subagent's `hooks`, `mcpServers` and `permissionMode`
 *   (`.claude/agents/*.md`), which, unlike a plugin subagent's, take effect.
 * - **Codex**: `.codex/` (`config.toml`, `hooks.json`).
 * - **OpenCode**: `opencode.json`, `opencode.jsonc` and `.opencode/` (its
 *   permission rules, servers, and plugins that run in-process).
 * - **Gemini CLI**: `.gemini/settings.json` (hooks, servers). DorkOS does not
 *   run Gemini sessions, but Harness Sync can project for it; refused so the
 *   rule holds for every harness, not only the ones run today.
 * - **Harness Sync**: `.agents/harness.manifest.json`, which chooses the
 *   harnesses DorkOS projects the folder's hooks into. DorkOS writes it.
 *
 * A `.claude/` folder is allowed only at the package root: Claude Code also
 * loads one below the root (nested skills and settings, when it works in that
 * folder), so a nested one is refused whatever it holds.
 *
 * ## The rule
 *
 * A packaged agent carries what the agent IS (its instructions, persona and
 * skills), never the configuration of the harness its sessions run under.
 * That is the rule ADR 260803-233420 already applies to `.dork/agent.json`'s
 * `mcpServers`: a packaged agent gets servers, hooks and permissions after
 * install, through DorkOS's own gated paths, where a person sees each one.
 *
 * Refused rather than disclosed: these files mix dozens of keys that run
 * programs or widen trust (Claude Code's settings alone has `env`, eight helper
 * commands, sandbox, plugin and MCP switches), each harness adds more, and an
 * allow rule once approved keeps approving tools with no DorkOS gate in front
 * of it. A card cannot show that honestly, and a list of keys DorkOS
 * understands goes stale the day a harness adds one. No published package
 * ships any of them.
 *
 * What stays allowed, because a person is shown it or it runs nothing:
 * `CLAUDE.md`, `AGENTS.md`, `.claude/CLAUDE.md` and `.claude/rules/`
 * (instructions), `.claude/output-styles/` (a prompt), `.claude/skills/`,
 * `.claude/commands/` and `.agents/skills/` (read by the install preview like
 * any skill: their hooks and allowed tools are on the card), and a subagent
 * that sets none of the three fields above.
 *
 * Names are compared the way a case-insensitive disk compares them, where
 * `.Claude/Settings.json` IS the file Claude Code loads. Everything fails
 * closed: a subagent whose header DorkOS cannot read the way Claude Code does
 * (not YAML, a repeated key) is refused, and so is one too deep to walk.
 *
 * @module agent-workspace-config
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '@dorkos/skills/frontmatter';

/** One refused path, for the validator to turn into an issue. */
export interface AgentWorkspaceConfigFinding {
  /** The package-relative path as shipped (a folder for `.codex/` and `.opencode/`). */
  path: string;
  /** One plain sentence saying why. */
  message: string;
}

/** A name folded the way a case-insensitive volume compares it. */
function fold(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

/** Which harness reads a refused path, for the message. */
const HARNESS_OF: Record<string, string> = {
  '.claude/settings.json': 'Claude Code',
  '.claude/settings.local.json': 'Claude Code',
  '.mcp.json': 'Claude Code',
  '.codex': 'Codex',
  'opencode.json': 'OpenCode',
  'opencode.jsonc': 'OpenCode',
  '.opencode': 'OpenCode',
  '.agents/harness.manifest.json': 'Harness Sync',
  '.gemini/settings.json': 'Gemini CLI',
  'nested .claude': 'Claude Code',
};

/** Subagent frontmatter fields that take effect in the agent's own sessions. */
const SUBAGENT_EFFECT_FIELDS = ['hooks', 'mcpServers', 'permissionMode'] as const;

/**
 * How deep `.claude/agents/` is walked; subagents are one or two levels down.
 * A folder deeper than this is refused, not skipped.
 */
const MAX_AGENTS_DEPTH = 3;

/** Folders the nested-`.claude` walk never enters: git's store, never shipped. */
const NESTED_WALK_SKIP = new Set(['.git']);

/** The sentence for a refused harness file. */
function refusal(shipped: string, canonical: string): AgentWorkspaceConfigFinding {
  return {
    path: shipped,
    message:
      (canonical === 'nested .claude'
        ? `An agent package can ship a .claude folder only at its root, not ${shipped}: `
        : `An agent package can't ship ${shipped}: `) +
      `its folder is the agent's working directory, so ` +
      `${HARNESS_OF[canonical]} would load it into every session the agent runs, without it ` +
      'being shown to you. Leave it out; hooks, servers and permissions are added after install ' +
      'through DorkOS, where a person approves each one.',
  };
}

/** Every entry in a directory that is not a link, or none when it cannot be read. */
async function entriesOf(dir: string): Promise<{ name: string; isDirectory: boolean }[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    // A link is stripped at staging and reported as LINK_SKIPPED; it never lands.
    return entries
      .filter((e) => !e.isSymbolicLink())
      .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  } catch {
    return [];
  }
}

/**
 * The subagent files under `.claude/agents/` that set a field which takes
 * effect in the agent's sessions, or whose frontmatter cannot be read.
 */
async function refusedSubagents(
  packagePath: string,
  agentsRel: string
): Promise<AgentWorkspaceConfigFinding[]> {
  const found: AgentWorkspaceConfigFinding[] = [];
  const visit = async (rel: string, depth: number): Promise<void> => {
    if (depth > MAX_AGENTS_DEPTH) {
      found.push({
        path: rel,
        message:
          `${rel} holds subagents deeper than DorkOS checks, so it cannot tell whether they ` +
          'run hooks or servers in the agent’s sessions. Keep subagents at most ' +
          `${MAX_AGENTS_DEPTH - 1} folders below .claude/agents.`,
      });
      return;
    }
    for (const entry of await entriesOf(path.join(packagePath, rel))) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory) {
        await visit(child, depth + 1);
        continue;
      }
      if (!fold(entry.name).endsWith('.md')) continue;
      let data: Record<string, unknown>;
      try {
        const text = await fs.readFile(path.join(packagePath, child), 'utf-8');
        // Claude Code reads a subagent's header as YAML only. A `---json` or
        // other header is one DorkOS and Claude Code could read differently
        // (JSON keeps the last of a repeated key silently), so it is refused;
        // YAML itself refuses a repeated key.
        if (/^---[^\S\r\n]*\S/.test(text)) throw new Error('not a YAML header');
        data = parseFrontmatter(text).data;
      } catch {
        found.push({
          path: child,
          message:
            `${child} is a subagent whose settings DorkOS cannot read the way Claude Code does, ` +
            'so it cannot tell whether it runs hooks or servers in the agent’s sessions. Give it ' +
            'a YAML header (---) with each setting once.',
        });
        continue;
      }
      const set = SUBAGENT_EFFECT_FIELDS.filter((field) => data[field] !== undefined);
      if (set.length > 0) {
        found.push({
          path: child,
          message:
            `${child} is a subagent that sets ${set.join(', ')}. In an agent package that takes ` +
            'effect in every session the agent runs, without being shown to you. Leave those ' +
            'fields out.',
        });
      }
    }
  };
  await visit(agentsRel, 1);
  return found;
}

/**
 * Every harness configuration file an agent package ships (see the module
 * documentation for the rule and why).
 *
 * @param packagePath - Absolute path to the agent package root.
 * @returns One finding per refused path, in a stable order.
 */
export async function findAgentWorkspaceConfig(
  packagePath: string
): Promise<AgentWorkspaceConfigFinding[]> {
  const found: AgentWorkspaceConfigFinding[] = [];
  for (const entry of await entriesOf(packagePath)) {
    const name = fold(entry.name);
    if (['.mcp.json', 'opencode.json', 'opencode.jsonc'].includes(name) && !entry.isDirectory) {
      found.push(refusal(entry.name, name));
    } else if (name === '.codex' || name === '.opencode') {
      found.push(refusal(entry.name, name));
    } else if (name === '.claude' && entry.isDirectory) {
      for (const child of await entriesOf(path.join(packagePath, entry.name))) {
        const childName = fold(child.name);
        const rel = `${entry.name}/${child.name}`;
        if (childName === 'settings.json' || childName === 'settings.local.json') {
          found.push(refusal(rel, `.claude/${childName}`));
        } else if (childName === 'agents' && child.isDirectory) {
          found.push(...(await refusedSubagents(packagePath, rel)));
        }
      }
    } else if (name === '.agents' && entry.isDirectory) {
      for (const child of await entriesOf(path.join(packagePath, entry.name))) {
        if (fold(child.name) === 'harness.manifest.json') {
          found.push(refusal(`${entry.name}/${child.name}`, '.agents/harness.manifest.json'));
        }
      }
    } else if (name === '.gemini' && entry.isDirectory) {
      for (const child of await entriesOf(path.join(packagePath, entry.name))) {
        if (fold(child.name) === 'settings.json') {
          found.push(refusal(`${entry.name}/${child.name}`, '.gemini/settings.json'));
        }
      }
    }
  }
  found.push(...(await nestedClaudeFolders(packagePath)));
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Every `.claude` folder below the package root, in any case. The walk skips
 * links (staging strips them) and git's own store, and has no depth limit: a
 * package's size is already bounded when it is fetched (DOR-2319), and a depth
 * limit here would be a place to hide one.
 */
async function nestedClaudeFolders(packagePath: string): Promise<AgentWorkspaceConfigFinding[]> {
  const found: AgentWorkspaceConfigFinding[] = [];
  const visit = async (rel: string): Promise<void> => {
    for (const entry of await entriesOf(path.join(packagePath, rel))) {
      if (!entry.isDirectory || NESTED_WALK_SKIP.has(entry.name)) continue;
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (rel !== '' && fold(entry.name) === '.claude') {
        found.push(refusal(child, 'nested .claude'));
        continue;
      }
      await visit(child);
    }
  };
  await visit('');
  return found;
}
