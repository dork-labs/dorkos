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
 * ## Protected names
 *
 * The folder and file names no web approval may touch, wherever they sit, and
 * the command tripwire that looks for them (and for the protected roots) in
 * the text of a `Bash` or `Shell` command. Used by `relay-approvable.ts`.
 *
 * Settings names: writing there changes what agents may do next.
 *
 * | Name                                      | Why                                     |
 * | ----------------------------------------- | --------------------------------------- |
 * | any `.claude*` folder                     | Claude Code settings, hooks and skills  |
 * | `.dork`, `.codex`, `.opencode`, `.agents` | DorkOS and harness settings and skills  |
 * | `opencode.json`, `opencode.jsonc`         | OpenCode settings, wherever they sit    |
 * | `.mcp.json`                               | which MCP servers a harness starts      |
 *
 * Run-later names: writing there plants code that runs later, outside the
 * one run the owner read.
 *
 * | Name                 | Why                                                    |
 * | -------------------- | ------------------------------------------------------ |
 * | any `.git` part      | hooks run on commit; config can name programs to run   |
 * | `.husky`             | git hooks, committed to the project                    |
 * | `.vscode`            | `tasks.json` can run when the folder opens             |
 * | `.idea`              | run configurations                                     |
 * | `.devcontainer`      | commands run when the container is built or opened     |
 * | `.github/workflows`  | runs in CI on the next push                            |
 * | `.envrc`             | direnv runs it on entering the folder                  |
 *
 * `.env` files stay allowed: they hold values, not code. `package.json`
 * scripts are code too, but refusing every `package.json` would refuse most
 * ordinary project work, so it stays allowed.
 *
 * The command check is a tripwire, not a parser. It refuses a command whose
 * text names a protected root (as written, or through `~`, `$HOME` or
 * `${HOME}`) or any name above. A command that hides the name (a variable,
 * base64, `cd` into a folder and then a relative path) still gets through:
 * that stays the accepted `Bash`/`Shell` residual named in
 * `relay-approvable.ts`.
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
 * OpenCode's global config folder: `$XDG_CONFIG_HOME/opencode`, and always
 * `~/.config/opencode` as well, the way OpenCode's own resolver reads it.
 */
function openCodeConfigDirs(): string[] {
  const home = relayHomeDir();
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

/** Folders whose contents decide what an agent harness may do (`.claude*` by prefix). */
const SETTINGS_FOLDERS = new Set(['.dork', '.codex', '.opencode', '.agents']);

/** Files that configure a harness wherever they sit. */
const SETTINGS_FILES = new Set(['opencode.json', 'opencode.jsonc', '.mcp.json']);

/** Folders whose contents run later: git hooks, editor tasks, containers. */
const RUN_LATER_FOLDERS = new Set(['.git', '.husky', '.vscode', '.idea', '.devcontainer']);

/** Files that run later wherever they sit. */
const RUN_LATER_FILES = new Set(['.envrc']);

/** A folder name no web approval may write under. Expects folded text. */
function protectedFolder(part: string): boolean {
  return part.startsWith('.claude') || SETTINGS_FOLDERS.has(part) || RUN_LATER_FOLDERS.has(part);
}

/** A file name no web approval may write. Expects folded text. */
function protectedFile(name: string): boolean {
  return SETTINGS_FILES.has(name) || RUN_LATER_FILES.has(name);
}

/** Whether the parts hold `.github` directly followed by `workflows`. */
function namesWorkflows(parts: readonly string[]): boolean {
  return parts.some((part, i) => part === '.github' && parts[i + 1] === 'workflows');
}

/**
 * Whether a resolved, folded path is under a protected name.
 *
 * @param target - An absolute path, already folded for case where case is ignored.
 * @returns True when any folder in it, or its file name, is protected.
 */
export function pathNamesProtected(target: string): boolean {
  const parts = target.split(path.sep);
  return (
    parts.some(protectedFolder) || protectedFile(path.basename(target)) || namesWorkflows(parts)
  );
}

/** What the command tripwire compares against. */
export interface CommandTripwireContext {
  /** The protected roots, as the caller resolved them. */
  protectedRoots: readonly string[];
  /** The home folder, for the `~` and `$HOME` spellings of a root; none when unknown. */
  homeDir: string | null;
  /** Folds text for comparison: lower case where case is ignored, as is elsewhere. */
  fold: (text: string) => string;
}

/** Every way a command may spell one protected root, folded. */
function rootSpellings(root: string, context: CommandTripwireContext): string[] {
  const spellings = [root];
  if (context.homeDir !== null) {
    const relative = path.relative(context.homeDir, root);
    if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      const tail = relative.split(path.sep).join('/');
      spellings.push(`~/${tail}`, `$HOME/${tail}`, `\${HOME}/${tail}`);
    }
  }
  return spellings.map(context.fold);
}

/**
 * Whether a command's text names a protected root or a protected name. A
 * tripwire, not a parser: see the module header for what it misses.
 *
 * @param command - The command text exactly as the card shows it.
 * @param context - The protected roots, the home folder and the case rule.
 * @returns True when the command should be decided at this computer.
 */
export function commandNamesProtected(command: string, context: CommandTripwireContext): boolean {
  const text = context.fold(command);
  if (
    context.protectedRoots.some((root) =>
      rootSpellings(root, context).some((s) => text.includes(s))
    )
  ) {
    return true;
  }
  // Words split on what a shell treats as a break; each word split on path separators.
  return text
    .split(/[\s'"`;|&<>()=,]+/)
    .map((word) => word.split(/[\\/]+/))
    .some(
      (parts) =>
        parts.some((part) => protectedFolder(part) || protectedFile(part)) || namesWorkflows(parts)
    );
}
