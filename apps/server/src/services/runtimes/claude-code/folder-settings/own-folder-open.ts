/**
 * Whether an agent's file tools may write its own folder setup (DOR-3483): its
 * `.claude/` (hooks, skills, rules, settings), `.agents/` and `.mcp.json`.
 *
 * A person who set an agent to Full autonomy already trusts it, and the deny
 * rules on its own folder only got in the way of an agent that follows them
 * (Bash was never covered). So the folder opens when ALL of these hold:
 *
 * - the level a PERSON set for the agent is Full (`resolveAgentLaunchLevel`,
 *   read through the permission gate, which never lets an agent's own file rise
 *   past what a person set), never a mode a `session_start` caller or a chat
 *   picked for one session;
 * - this turn also runs at Full, its ceiling applied;
 * - it is not a teammate's turn;
 * - it carries no outsider or teammate mark and no ceiling
 *   (`ownExtensionsWritable`, the same answer that keeps a marked turn out of its
 *   own mini apps): a turn that read outside words keeps today's denies.
 *
 * What stays denied whatever the answer: the agent's `.dork/agent.json` (its
 * level, account and held MCP servers), other agents' folders, DorkOS's data
 * folder (`config.json` and the approvals in it, `host.key`, tokens) and the
 * Claude account files. Those are guarded against file tools only.
 *
 * Every change to the open files is logged (`own-folder-watch.ts`), and a later
 * drop below Full puts what the agent wrote back behind the folder-settings card
 * once (`launch-folder-config.ts`: nothing loaded at Full is recorded as approved).
 *
 * @module services/runtimes/claude-code/folder-settings/own-folder-open
 */
import type { Options, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { logger } from '../../../../lib/logger.js';
import { resolveAgentLaunchLevel } from '../../../session/resolution/agent-launch-level.js';
import { CLAUDE_CODE_CAPABILITIES } from '../runtime-constants.js';
import { ownExtensionsWritable } from './agent-extensions-deny.js';
import { noteOwnFolderChanges } from './own-folder-watch.js';

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
    const level = await resolveAgentLaunchLevel({
      agentPath: home,
      capabilities: 'capabilities' in turn ? turn.capabilities : CLAUDE_CODE_CAPABILITIES,
    });
    return level.mode === FULL_MODE;
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
records, host.key, tokens and Claude account files. They are guarded against file tools only, not
the shell. Leave them alone either way. If your level drops below Full, what you changed waits for a
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
 * Decide one launch's answer and act on it when open: log any change since the
 * last look, and tell the agent what it may edit ({@link appendOwnFolderBlock}).
 *
 * @param sdkOptions - The launch options, mutated when the folder is open.
 * @param turn - The turn, and what to call its agent in the log.
 */
export async function prepareOwnFolder(
  sdkOptions: Options,
  turn: OwnFolderTurn & { agentName?: string | null | undefined }
): Promise<OwnFolderLaunch> {
  const open = await resolveOwnFolderOpen(turn);
  const chat = { sessionId: turn.sessionId, agentPath: turn.home, ownFolderOpen: open };
  if (!open || !turn.home) return { open, chat, atTurnEnd: async () => {} };
  const watch = {
    home: turn.home,
    sessionId: turn.sessionId,
    ...(turn.agentName ? { agentName: turn.agentName } : {}),
  };
  await noteOwnFolderChanges(watch, 'launch');
  appendOwnFolderBlock(sdkOptions);
  return { open, chat, atTurnEnd: () => noteOwnFolderChanges(watch, 'turn-end') };
}
