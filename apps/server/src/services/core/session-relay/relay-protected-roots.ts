/**
 * The folders no approval from the web may write in, as DorkOS itself
 * resolves them on this machine: its own data folder and the folders each
 * agent harness reads its settings, accounts and skills from. Read fresh on
 * every check, so an account added or a variable changed counts at once.
 *
 * Every folder comes from the resolver that owns it, so this list cannot drift
 * from where DorkOS actually runs each harness. The one path spelled here is
 * OpenCode's config folder, which no resolver names yet.
 *
 * @module services/core/session-relay/relay-protected-roots
 */
import path from 'node:path';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { logger } from '../../../lib/logger.js';
import { agentsUserSkillsDir } from '../../harness/agents-user-home.js';
import {
  inheritedClaudeRoot,
  listClaudeAccountFolderCandidates,
  resolveClaudeRootSet,
} from '../../runtimes/claude-code/claude-config-dir.js';
import { machineDefaultCodexHome, resolveCodexHome } from '../../runtimes/codex/codex-home.js';
import { resolveOpenCodeDataDir } from '../../runtimes/opencode/opencode-data-dir.js';

/**
 * OpenCode's global config folder: `$XDG_CONFIG_HOME/opencode`, and always
 * `~/.config/opencode` as well, the way OpenCode's own resolver reads it.
 * The home folder is taken from the Codex resolver's default (`~/.codex`),
 * because only the Hard Rule 3 carve-outs may ask the OS for it.
 */
function openCodeConfigDirs(): string[] {
  const home = path.dirname(machineDefaultCodexHome());
  // eslint-disable-next-line no-restricted-syntax -- XDG_CONFIG_HOME is OpenCode's own variable, not a DorkOS setting env.ts models
  const xdg = process.env.XDG_CONFIG_HOME;
  return [
    path.join(home, '.config', 'opencode'),
    ...(xdg !== undefined && xdg !== '' ? [path.join(xdg, 'opencode')] : []),
  ];
}

/** Every Claude Code account folder DorkOS knows, or none when the config cannot be read. */
function claudeRoots(): string[] {
  try {
    return [
      inheritedClaudeRoot(),
      ...resolveClaudeRootSet(),
      ...listClaudeAccountFolderCandidates(),
    ];
  } catch (error) {
    logger.warn('[SessionRelay] Could not list Claude Code folders for web approvals', {
      error: (error as Error).name,
    });
    // Fails closed in effect: every `.claude*` folder is refused by name anyway.
    return [inheritedClaudeRoot()];
  }
}

/**
 * The folders no web approval may write in.
 *
 * @returns Absolute folders: DorkOS's data folder, every Claude Code account
 *   folder, the Codex home, OpenCode's data and config folders, and `~/.agents`.
 */
export function relayProtectedRoots(): string[] {
  return [
    ...new Set([
      resolveDorkHome(),
      ...claudeRoots(),
      resolveCodexHome(),
      machineDefaultCodexHome(),
      resolveOpenCodeDataDir(),
      ...openCodeConfigDirs(),
      path.dirname(agentsUserSkillsDir()),
    ]),
  ];
}
