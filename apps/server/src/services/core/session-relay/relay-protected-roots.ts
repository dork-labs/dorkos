/**
 * The folders no approval from the web may write in, as DorkOS itself
 * resolves them on this machine: its own data folder and the folders each
 * agent harness reads its settings, accounts and skills from. Read fresh on
 * every check, so an account added or a variable changed counts at once.
 *
 * Every folder comes from the resolver that owns it, so this list cannot drift
 * from where DorkOS actually runs each harness. The paths spelled here are
 * OpenCode's config folder, which no resolver names yet, and the home
 * folder's places that run code later (`homeRunLaterPlaces`), which no
 * DorkOS resolver owns.
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
 * The home folder, taken from the Codex resolver's default (`~/.codex`),
 * because only the Hard Rule 3 carve-outs may ask the OS for it.
 *
 * @returns The absolute home folder.
 */
export function relayHomeDir(): string {
  return path.dirname(machineDefaultCodexHome());
}

/**
 * `$XDG_CONFIG_HOME` when set, which OpenCode, git, systemd and fish read
 * their config from instead of `~/.config`.
 *
 * @returns The absolute folder, or `null` when the variable is unset.
 */
export function relayXdgConfigHome(): string | null {
  // eslint-disable-next-line no-restricted-syntax -- XDG_CONFIG_HOME belongs to OpenCode, git, systemd and fish, not a DorkOS setting env.ts models
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg !== undefined && xdg !== '' ? xdg : null;
}

/** Every config folder a program reads: `~/.config` always, and `$XDG_CONFIG_HOME` when set. */
function configDirs(home: string, xdgConfigHome: string | null): string[] {
  return [path.join(home, '.config'), ...(xdgConfigHome !== null ? [xdgConfigHome] : [])];
}

/**
 * The places in the home folder whose contents run later, outside the one
 * run the owner read: shell startup files, git's global config and hooks,
 * SSH config and keys, and login items on macOS and Linux.
 *
 * | Place                                  | Why                                       |
 * | -------------------------------------- | ----------------------------------------- |
 * | `~/.gitconfig`, `~/.config/git/`       | can name programs git runs, global hooks  |
 * | `~/.zshrc`, `~/.zshenv`, `~/.zprofile` | run by every zsh                          |
 * | `~/.bashrc`, `~/.bash_profile`         | run by every bash                         |
 * | `~/.profile`                           | run at login                              |
 * | `~/.ssh/`                              | `config` runs commands; keys grant access |
 * | `~/Library/LaunchAgents/`              | macOS runs these at login                 |
 * | `~/.config/systemd/user/`              | Linux runs these as services              |
 * | `~/.config/autostart/`                 | Linux desktops run these at login         |
 * | `~/.config/fish/`                      | run by every fish shell                   |
 *
 * @param home - The home folder.
 * @param xdgConfigHome - `$XDG_CONFIG_HOME`, or `null` when unset.
 * @returns Absolute files and folders, refused like the protected roots.
 */
export function homeRunLaterPlaces(home: string, xdgConfigHome: string | null): string[] {
  return [
    ...['.gitconfig', '.zshrc', '.zshenv', '.zprofile', '.bashrc', '.bash_profile', '.profile'].map(
      (name) => path.join(home, name)
    ),
    path.join(home, '.ssh'),
    path.join(home, 'Library', 'LaunchAgents'),
    ...configDirs(home, xdgConfigHome).flatMap((config) =>
      ['git', path.join('systemd', 'user'), 'autostart', 'fish'].map((rest) =>
        path.join(config, rest)
      )
    ),
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
 *   folder, the Codex home, OpenCode's data and config folders, `~/.agents`,
 *   and the home folder's run-later places (`homeRunLaterPlaces`).
 */
export function relayProtectedRoots(): string[] {
  const home = relayHomeDir();
  const xdg = relayXdgConfigHome();
  return [
    ...new Set([
      resolveDorkHome(),
      ...claudeRoots(),
      resolveCodexHome(),
      machineDefaultCodexHome(),
      resolveOpenCodeDataDir(),
      // OpenCode reads `$XDG_CONFIG_HOME/opencode` and always `~/.config/opencode`.
      ...configDirs(home, xdg).map((config) => path.join(config, 'opencode')),
      path.dirname(agentsUserSkillsDir()),
      ...homeRunLaterPlaces(home, xdg),
    ]),
  ];
}
