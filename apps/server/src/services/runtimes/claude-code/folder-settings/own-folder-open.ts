/**
 * Whether an agent's file tools may write its own folder setup (DOR-3483): its
 * `.claude/` (hooks, skills, rules, settings), `.agents/` and `.mcp.json`.
 *
 * A person who set an agent to Full autonomy already trusts it, and the deny
 * rules on its own folder only got in the way of an agent that follows them
 * (Bash was never covered). So the folder opens when ALL of these hold:
 *
 * - the agent's OWN Files & commands level is Full (`readAgentExecutionDefaults`,
 *   read through the permission gate, which never lets an agent's own file rise
 *   past what a person set). Full inherited from a preset or the global default
 *   does not count (PM, #3319), and neither does a mode a `session_start` caller
 *   or a chat picked for one session;
 * - this turn also runs at Full, its ceiling applied;
 * - it is not a teammate's turn;
 * - it carries no outsider or teammate mark and no ceiling
 *   (`ownExtensionsWritable`, the same answer that keeps a marked turn out of its
 *   own mini apps): a turn that read outside words keeps today's denies.
 *
 * What stays denied whatever the answer: the agent's `.dork/agent.json` (its
 * level, account and held MCP servers), other agents' folders, DorkOS's data
 * folder (`config.json` and the approvals in it, `host.key`, tokens) and the
 * Claude account files: an open launch carries the whole `selfGrantDenyRules`
 * set (Security M2 on #3319). So does every link in the open parts that leads
 * outside the home, and the file behind it (M1): a person's shared rule linked
 * in stays theirs. When any of those can't be named in a rule, the folder stays
 * closed. Those are guarded against file tools only.
 *
 * Every change to the open files is logged (`own-folder-watch.ts`), and a later
 * drop below Full puts what the agent wrote back behind the folder-settings card
 * once (`launch-folder-config.ts`: nothing loaded at Full is recorded as approved).
 *
 * @module services/runtimes/claude-code/folder-settings/own-folder-open
 */
import type { Options, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { logger } from '../../../../lib/logger.js';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import {
  readAgentExecutionDefaults,
  resolveUnattendedPermissionMode,
} from '../../../session/resolution/resolve-session-defaults.js';
import { writeDenyRules } from '../messaging/directory-grants.js';
import { CLAUDE_CODE_CAPABILITIES } from '../runtime-constants.js';
import { ownExtensionsWritable } from './agent-extensions-deny.js';
import { selfGrantDenyRules } from './apply-folder-allows.js';
import { linksOutsideHome, noteOwnFolderChanges } from './own-folder-watch.js';

/** Claude Code's Full autonomy mode. */
const FULL_MODE = 'bypassPermissions';

/** What {@link resolveOwnFolderOpen} reads about one launch. */
export interface OwnFolderTurn {
  /** The turn's registered agent home, if any. */
  home: string | undefined;
  /** Whether this is a teammate's turn. */
  teammate: boolean;
  /** The mode this turn really launches at, its ceiling applied. */
  turnMode: PermissionMode | string;
  /** The session's ceilings. */
  session: Parameters<typeof ownExtensionsWritable>[0];
  /** The launching session. */
  sessionId: string;
  /** The runtime the turn launches on, to read the agent's level as its mode. Claude Code's by default. */
  capabilities?: RuntimeCapabilities | undefined;
}

/**
 * Decide whether this launch opens the agent's own folder setup. Fails closed:
 * a level that can't be read reads as not Full.
 *
 * @param turn - Who the turn is for, its mode and its marks.
 */
export async function resolveOwnFolderOpen(turn: OwnFolderTurn): Promise<boolean> {
  const { home } = turn;
  if (!home || turn.teammate || turn.turnMode !== FULL_MODE) return false;
  if (ownExtensionsWritable(turn.session, turn.sessionId, home) === undefined) return false;
  try {
    // The agent's own stop only: a preset's or the global Full is not a person's choice for it.
    const { filesAndCommands } = await readAgentExecutionDefaults(home);
    if (filesAndCommands !== 'autonomy') return false;
    const mode = resolveUnattendedPermissionMode({
      capabilities: 'capabilities' in turn ? turn.capabilities : CLAUDE_CODE_CAPABILITIES,
      agent: { filesAndCommands },
    });
    return mode === FULL_MODE;
  } catch (err) {
    logger.warn("[OwnFolder] Could not read the agent's level; its folder stays closed", {
      home,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * What an agent whose own folder is open is told, so it knows what it may now
 * edit and what stays held back.
 */
export const OWN_FOLDER_BLOCK = `<own_folder>
A person set you to Full autonomy, so you may edit your own folder's setup with any tool: .claude/
(hooks, skills, rules, settings), .agents/ and .mcp.json. Each change you make there shows in Activity.
Still held back: your .dork/agent.json, other agents' folders, DorkOS's config.json and approval
records, host.key, tokens, Claude account files, and any file your folder links to from outside it.
They are guarded against file tools only, not the shell. Leave them alone either way. If your level drops below Full, what you changed waits for a
person's approval once.
</own_folder>`;

/**
 * Tell the agent its own folder is open: {@link OWN_FOLDER_BLOCK} appended to
 * the launch's system prompt. A preset prompt only, as every other append.
 *
 * @param sdkOptions - The launch options, mutated.
 */
export function appendOwnFolderBlock(sdkOptions: Options): void {
  const prompt = sdkOptions.systemPrompt;
  if (typeof prompt !== 'object' || Array.isArray(prompt) || prompt.type !== 'preset') return;
  if (prompt.append?.includes('<own_folder>')) return;
  sdkOptions.systemPrompt = {
    ...prompt,
    append: prompt.append ? `${prompt.append}\n\n${OWN_FOLDER_BLOCK}` : OWN_FOLDER_BLOCK,
  };
}

/** What one launch carries about its agent's own folder. */
export interface OwnFolderLaunch {
  /** Whether the turn may write its own folder setup. */
  open: boolean;
  /** The chat for `applyPersonOnlyDataDeny`, with the answer. */
  chat: { sessionId: string; agentPath: string | undefined; ownFolderOpen: boolean };
  /** Look for changes at the turn's end and log them; nothing when the folder is closed. */
  atTurnEnd: () => Promise<void>;
}

/**
 * Decide one launch's answer and act on it when open: carry the rules that
 * still hold ({@link openFolderDenyRules}), log any change since the last look,
 * and tell the agent what it may edit ({@link appendOwnFolderBlock}).
 *
 * @param sdkOptions - The launch options, mutated when the folder is open.
 * @param turn - The turn, its Claude Code account folder, and what to call its agent in the log.
 */
export async function prepareOwnFolder(
  sdkOptions: Options,
  turn: OwnFolderTurn & { accountRoot: string; agentName?: string | null | undefined }
): Promise<OwnFolderLaunch> {
  const closed = (): OwnFolderLaunch => ({
    open: false,
    chat: { sessionId: turn.sessionId, agentPath: turn.home, ownFolderOpen: false },
    atTurnEnd: async () => {},
  });
  if (!turn.home || !(await resolveOwnFolderOpen(turn))) return closed();
  const deny = await openFolderDenyRules(turn.home, resolveDorkHome(), turn.accountRoot);
  if (!deny) {
    logger.warn(
      "[OwnFolder] A path it must keep can't be named in a rule; the folder stays closed",
      {
        home: turn.home,
      }
    );
    return closed();
  }
  mergeDeny(sdkOptions, deny);
  const open = true;
  const chat = { sessionId: turn.sessionId, agentPath: turn.home, ownFolderOpen: open };
  const watch = {
    home: turn.home,
    sessionId: turn.sessionId,
    ...(turn.agentName ? { agentName: turn.agentName } : {}),
  };
  await noteOwnFolderChanges(watch, 'launch');
  appendOwnFolderBlock(sdkOptions);
  return { open, chat, atTurnEnd: () => noteOwnFolderChanges(watch, 'turn-end') };
}

/**
 * The write-deny rules an open launch carries beyond the every-launch set: the
 * whole {@link selfGrantDenyRules} set with the own folder left out (the Claude
 * account folder and its home spellings, the data folder's `host.key`, tokens
 * and config, every other agent home), and every link in the open parts that
 * leads outside the home, by its own path through both spellings of the home
 * and by the path behind it. `undefined` when any of them can't be named.
 *
 * @param home - The agent home.
 * @param dorkHome - DorkOS's data folder.
 * @param accountRoot - The launch's Claude Code account folder.
 */
export async function openFolderDenyRules(
  home: string,
  dorkHome: string,
  accountRoot: string
): Promise<string[] | undefined> {
  const base = selfGrantDenyRules({ home, dorkHome, accountRoot, ownFolderOpen: true });
  if (!base) return undefined;
  const rules = [...base];
  const resolved = path.resolve(home);
  const real = await realpath(resolved).catch(() => resolved);
  for (const { link, target, folder } of await linksOutsideHome(home)) {
    const kind = folder ? 'folder' : 'file';
    const spellings = new Set([link, target]);
    if (real !== resolved && link.startsWith(`${resolved}${path.sep}`)) {
      spellings.add(`${real}${link.slice(resolved.length)}`);
    }
    for (const spelling of spellings) {
      const named = writeDenyRules(spelling, kind);
      if (!named) return undefined;
      rules.push(...named);
    }
  }
  return [...new Set(rules)];
}

/** Add deny rules to a launch's settings, keeping every other setting. */
function mergeDeny(sdkOptions: Options, rules: readonly string[]): void {
  const base =
    typeof sdkOptions.settings === 'object' && sdkOptions.settings !== null
      ? sdkOptions.settings
      : {};
  const permissions = ((base as { permissions?: { deny?: string[] } }).permissions ?? {}) as {
    deny?: string[];
  };
  const denied = [...(permissions.deny ?? [])];
  for (const rule of rules) if (!denied.includes(rule)) denied.push(rule);
  sdkOptions.settings = {
    ...base,
    permissions: { ...permissions, deny: denied },
  } as Options['settings'];
}
