/**
 * The agent's own home, added to a Claude Code launch that works outside it, so
 * the home's skills, commands and agents load and show in the `/` menu
 * (DOR-5250).
 *
 * In an SDK session an unknown `/name` is answered "Unknown command" and never
 * reaches the model, so listing the home's skills in the prompt (DOR-3941) was
 * not enough to run one. Claude Code loads skills, commands and agents from a
 * folder passed at launch as `Options.additionalDirectories` (`--add-dir`). The
 * folder grants a room turn carries stay in `settings.permissions`, which loads
 * none of that, because a room's files are other people's (`directory-grants.ts`).
 * The home is the agent's own, from the registry, never a room's.
 *
 * ## What an added folder must not bring
 *
 * - **Its `CLAUDE.md`.** Claude Code reads an added folder's `CLAUDE.md` when
 *   `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` is set. The agent can write
 *   that file, and reading it every turn would make one injected write last. The
 *   variable is dropped from the launch's environment and blanked in its
 *   flag-level `settings.env`, which outranks a user or project settings file
 *   that sets it.
 * - **Its settings and MCP servers.** Its `.claude/settings.json` hooks and
 *   permissions, and its `.mcp.json`, do not load from an added folder, so the
 *   held-back switches for them (`launch-folder-config.ts`) are not needed here.
 *   Run, not reasoned: `home-skills-folder.binary.test.ts`.
 * - **Write access to its self-grant files.** An added folder is a working
 *   folder, so the edit tools reach it. The deny rules every launch carries for
 *   the home (`homeWriteDenyRules`) still refuse `.dork/agent.json`, its
 *   settings and its skills; the same binary test shows it.
 *
 * @module services/runtimes/claude-code/tooling/home-skills-folder
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { CommandRegistry } from '@dorkos/shared/types';
import { homeOutside } from '../../shared/home-skills-block.js';
import { withHomeSkillCommands } from '../../shared/home-skill-commands.js';
import type { CommandRegistryService } from './command-registry.js';
import { GRANT_CLAUDE_MD_ENV_VAR } from '../messaging/directory-grants.js';
import type { RuntimeCache } from '../messaging/runtime-cache.js';

/**
 * Add the agent's home to the launch's folders, and keep its `CLAUDE.md` out.
 * A no-op without a home: the session works inside it, or has no agent.
 *
 * @param sdkOptions - The launch options, mutated in place.
 * @param home - `homeOutside`'s answer for this turn, or `undefined` to add nothing.
 */
export function applyHomeSkillsFolder(sdkOptions: Options, home: string | undefined): void {
  if (!home) return;
  const folders = sdkOptions.additionalDirectories ?? [];
  if (!folders.includes(home)) sdkOptions.additionalDirectories = [...folders, home];
  if (sdkOptions.env && GRANT_CLAUDE_MD_ENV_VAR in sdkOptions.env) {
    const { [GRANT_CLAUDE_MD_ENV_VAR]: _dropped, ...rest } = sdkOptions.env;
    sdkOptions.env = rest;
  }
  const base =
    typeof sdkOptions.settings === 'object' && sdkOptions.settings !== null
      ? sdkOptions.settings
      : {};
  const env = (base as { env?: Record<string, string> }).env ?? {};
  sdkOptions.settings = {
    ...base,
    env: { ...env, [GRANT_CLAUDE_MD_ENV_VAR]: '' },
  } as Options['settings'];
}

/**
 * The key a folder's Claude Code command list is cached under for a turn. A
 * launch that adds a home reports that home's skills too, so its list is kept
 * apart from the folder's own: another agent's session in the same folder, or
 * a session with no agent, never sees them.
 *
 * @param cwd - The session's working folder.
 * @param agentPath - The agent the turn is for, when the server names one.
 */
export function commandsKeyFor(cwd: string, agentPath: string | undefined): string {
  const home = homeOutside(cwd, agentPath);
  return home ? `${cwd}\u0000home:${home}` : cwd;
}

/**
 * The `/` menu for a session in `cwd`. Inside its home, or with no agent, the
 * folder's own list. Outside it, the list a launch with the home reported once
 * one has run, and until then the folder's list with the home's skills added.
 *
 * @param cache - The runtime's command cache.
 * @param registry - The folder's command scanner.
 * @param cwd - The session's working folder.
 * @param agentPath - The session's agent, as the server recorded it.
 * @param forceRefresh - Re-scan the folder.
 */
export async function commandsWithHome(
  cache: Pick<RuntimeCache, 'hasSdkCommands' | 'getCommands'>,
  registry: CommandRegistryService,
  cwd: string,
  agentPath: string | undefined,
  forceRefresh?: boolean
): Promise<CommandRegistry> {
  const key = commandsKeyFor(cwd, agentPath);
  if (key === cwd || cache.hasSdkCommands(key)) {
    return cache.getCommands(registry, key, forceRefresh);
  }
  const listed = await cache.getCommands(registry, cwd, forceRefresh);
  return { ...listed, commands: withHomeSkillCommands(listed.commands, cwd, agentPath) };
}

/**
 * The commands a turn's `/name` is checked against, from the list its own
 * launch reported, or `null` before one has: built-ins are unknowable then, so
 * the sender passes command-shaped content through unverified (DOR-107).
 *
 * @param cache - The runtime's command cache.
 * @param registry - The folder's command scanner.
 * @param key - {@link commandsKeyFor}'s answer for the turn.
 */
export async function knownCommands(
  cache: Pick<RuntimeCache, 'hasSdkCommands' | 'getCommands'>,
  registry: CommandRegistryService,
  key: string
): Promise<string[] | null> {
  if (!cache.hasSdkCommands(key)) return null;
  const { commands } = await cache.getCommands(registry, key);
  return commands.map((entry) => entry.fullCommand);
}
