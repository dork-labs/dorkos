/**
 * The note a person's change to an agent's level carries: how many of that
 * agent's existing chats the new level now reaches (DOR-3175).
 *
 * Nothing is rewritten when a level changes. Each chat meets the new level at
 * its next turn's start (`turn-power/agent-level-bound.ts`), so this counts,
 * by the same rules, the chats whose next turn will run differently: held down
 * to a lower level, or (for a chat that follows its agent) started at a higher
 * one. The history line is the record; there is no Undo of its own, since
 * setting the level back is the Undo.
 *
 * @module services/core/permissions/level-reach-note
 */
import type { PermissionChange } from '@dorkos/shared/permissions';
import {
  clampModeToCeiling,
  levelOfMode,
  type DeclaredModes,
} from '@dorkos/shared/permission-semantics';
import { isChosenMode, isKept } from './existing-chats-raise.js';

/** One chat of an agent, as `session_metadata` holds it. */
export interface AgentChatRow {
  sessionId: string;
  runtime: string | null;
  permissionMode: string | null;
}

/** What the count reads. */
export interface LevelReachDeps {
  /** Every chat recorded for an agent's folder. */
  chatsOf: (agentPath: string) => AgentChatRow[];
  /** A runtime's declared modes, or `undefined` for one this server lacks. */
  modes: (runtime: string) => DeclaredModes | undefined;
  /** The agent's current level as a runtime's mode, or `undefined` when nothing is set. */
  levelModeOf: (agentPath: string, runtime: string) => Promise<string | undefined>;
  /** Whether a chat follows its agent up (`chat-rise-facts.ts`). */
  mayRise: (sessionId: string) => boolean;
}

/** Chats on another computer, which this one cannot vouch for. */
const COMPUTER_LOCAL_RUNTIME = 'computer-local';

/** Whether a chat's next turn runs differently at a level than at its stored mode. */
function reaches(
  declared: DeclaredModes,
  stored: string,
  levelMode: string,
  follows: boolean
): boolean {
  const level = levelOfMode(declared, levelMode);
  const current = levelOfMode(declared, stored);
  if (!level || !current) return false;
  if (clampModeToCeiling(declared, stored, level) !== stored) return true;
  return follows && clampModeToCeiling(declared, levelMode, current) !== levelMode;
}

/**
 * The note for a count.
 *
 * @param count - How many existing chats the new level reaches.
 */
export function levelReachSentence(count: number): string {
  if (count === 0) return 'No existing chats change.';
  return count === 1
    ? '1 existing chat runs at the new level from its next turn.'
    : `${count} existing chats run at the new level from their next turn.`;
}

/**
 * Build the note reader the permission service records with.
 *
 * @param deps - The chats, modes, levels and rise facts.
 * @returns The note for a change that moves an agent's level, else `undefined`.
 */
export function createLevelReachNote(
  deps: LevelReachDeps
): (changes: readonly PermissionChange[]) => Promise<string | undefined> {
  return async (changes) => {
    const agents = new Set(
      changes
        .filter((c) => c.key.kind === 'files' && c.target.kind === 'agent')
        .map((c) => (c.target.kind === 'agent' ? c.target.agentPath : ''))
        .filter((agentPath) => agentPath !== '')
    );
    if (agents.size === 0) return undefined;
    let count = 0;
    for (const agentPath of agents) {
      const kept = isKept({ projectPath: agentPath, name: '', displayName: '' });
      for (const chat of deps.chatsOf(agentPath)) {
        if (!chat.runtime) continue;
        const declared = deps.modes(chat.runtime);
        const stored = chat.permissionMode ?? declared?.default;
        if (!declared || !stored) continue;
        const levelMode = await deps.levelModeOf(agentPath, chat.runtime);
        if (!levelMode) continue;
        const follows =
          !kept &&
          chat.runtime !== COMPUTER_LOCAL_RUNTIME &&
          !isChosenMode(declared, stored) &&
          deps.mayRise(chat.sessionId);
        if (reaches(declared, stored, levelMode, follows)) count += 1;
      }
    }
    return levelReachSentence(count);
  };
}
