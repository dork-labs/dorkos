/**
 * The note a person's change to a level carries: how many existing chats the
 * change reaches, from their next turn (DOR-3175). Nothing is rewritten when a
 * level changes; each chat meets it at its next turn's start
 * (`turn-power/agent-level-bound.ts`), so this compares, per chat, the mode its
 * next turn ran at under the old level with the one it runs at under the new.
 *
 * Counted by direction (Security, 2026-10-20):
 *
 * - **Down:** every chat whose next turn now runs lower, marked ones included,
 *   since the cap reaches them too. "14 chats follow it".
 * - **Up:** only chats that really go up. A marked or held chat's turns stay
 *   capped by their marks, so it is left out; a chat a person set by hand
 *   keeps its own mode and is named as staying lower. "12 chats rose, 2 set by
 *   hand stay lower".
 *
 * Covers an agent's own level and the global and per-runtime levels an agent
 * with none of its own inherits. A change that reaches no chat carries no note.
 * There is no Undo of its own: setting the level back is the undo.
 *
 * @module services/core/permissions/level-reach-note
 */
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import type { PermissionChange } from '@dorkos/shared/permissions';
import {
  clampModeToCeiling,
  levelOfMode,
  resolveStopMode,
  type DeclaredModes,
} from '@dorkos/shared/permission-semantics';
import type { LevelAgent } from '../turn-power/agent-level-bound.js';
import { isChosenMode, isKept } from './existing-chats-raise.js';

/** One chat, as `session_metadata` and its native binding hold it. */
export interface LevelChatRow {
  sessionId: string;
  runtime: string | null;
  permissionMode: string | null;
  /** The agent recorded for the chat at launch. */
  agentPath: string | null;
  /** Where the chat stands, when its runtime recorded it. */
  cwd: string | null;
}

/** The levels an agent's own stop falls back to. */
export interface DefaultStops {
  /** The global stop. */
  global: PermissionStop | null;
  /** Each runtime's own stop, by runtime id. */
  perRuntime: Readonly<Record<string, PermissionStop | null>>;
}

/** What the count reads. */
export interface LevelReachDeps {
  /** Every chat. */
  chats: () => LevelChatRow[];
  /** Whose level holds a chat (`resolveLevelAgent`), so the count agrees with the turn. */
  agentOf: (chat: LevelChatRow) => LevelAgent;
  /** A runtime's declared modes, or `undefined` for one this server lacks. */
  modes: (runtime: string) => DeclaredModes | undefined;
  /** An agent's own Files & commands stop, as the permission gate reads it now. */
  ownStop: (agentPath: string) => Promise<PermissionStop | null>;
  /** The global and per-runtime stops now. */
  defaultStops: () => DefaultStops;
  /** Whether a chat's turns carry a mark or a hold (launch marks, held, a stranger reached it). */
  marked: (sessionId: string) => boolean;
  /** Whether a person set the chat's mode by hand. */
  personSet: (sessionId: string) => boolean;
}

/** Chats on another computer, which this one cannot vouch for. */
const COMPUTER_LOCAL_RUNTIME = 'computer-local';

/** The stops before a change: its `before` put back where it landed. */
interface StopsAt {
  own: PermissionStop | null;
  runtime: PermissionStop | null;
  global: PermissionStop | null;
}

/** The mode a chat's next turn starts at, under one level. */
function effectiveMode(
  declared: DeclaredModes,
  stored: string,
  levelMode: string | undefined,
  follows: boolean
): string {
  if (levelMode === undefined) return stored;
  const level = levelOfMode(declared, levelMode);
  const current = levelOfMode(declared, stored);
  if (!level || !current) return stored;
  if (follows && clampModeToCeiling(declared, levelMode, current) !== levelMode) return levelMode;
  return clampModeToCeiling(declared, stored, level);
}

/** Whether `a` is a looser mode than `b`. */
function looser(declared: DeclaredModes, a: string, b: string): boolean {
  const level = levelOfMode(declared, b);
  return level !== undefined && a !== b && clampModeToCeiling(declared, a, level) !== a;
}

/**
 * The note for the counts, or `undefined` when nothing changes.
 *
 * @param rose - Chats whose next turn now runs higher.
 * @param fell - Chats whose next turn now runs lower.
 * @param heldByHand - Chats set by hand that a raise leaves lower.
 */
export function levelReachSentence(
  rose: number,
  fell: number,
  heldByHand: number
): string | undefined {
  const parts: string[] = [];
  if (fell > 0) parts.push(fell === 1 ? '1 chat follows it' : `${fell} chats follow it`);
  if (rose > 0) parts.push(rose === 1 ? '1 chat rose' : `${rose} chats rose`);
  if (rose > 0 && heldByHand > 0) parts.push(`${heldByHand} set by hand stay lower`);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * Build the note reader the permission service records with.
 *
 * @param deps - The chats, modes, levels and facts.
 * @returns The note for a change that moves a level, else `undefined`.
 */
export function createLevelReachNote(
  deps: LevelReachDeps
): (changes: readonly PermissionChange[]) => Promise<string | undefined> {
  return async (changes) => {
    const moves = changes.filter((c) => c.key.kind === 'files');
    if (moves.length === 0) return undefined;
    const defaults = deps.defaultStops();
    let rose = 0;
    let fell = 0;
    let heldByHand = 0;
    for (const chat of deps.chats()) {
      const agent = deps.agentOf(chat);
      if (agent === undefined || agent === 'unmatched' || !chat.runtime) continue;
      const declared = deps.modes(chat.runtime);
      const stored = chat.permissionMode ?? declared?.default;
      if (!declared || !stored) continue;
      const now: StopsAt = {
        own: await deps.ownStop(agent.agentPath),
        runtime: defaults.perRuntime[chat.runtime] ?? null,
        global: defaults.global,
      };
      const then: StopsAt = { ...now };
      let touched = false;
      for (const change of moves) {
        if (change.key.kind !== 'files') continue;
        const before = (change.before as PermissionStop | null) ?? null;
        if (change.target.kind === 'agent') {
          if (change.target.agentPath !== agent.agentPath) continue;
          then.own = before;
        } else if (change.key.runtime !== undefined) {
          if (change.key.runtime !== chat.runtime) continue;
          then.runtime = before;
        } else {
          then.global = before;
        }
        touched = true;
      }
      if (!touched) continue;
      const modeAt = (s: StopsAt) =>
        resolveStopMode(s.own ?? s.runtime ?? s.global, declared.values);
      const marked = deps.marked(chat.sessionId);
      const byHand = deps.personSet(chat.sessionId);
      const follows =
        agent.exact &&
        !marked &&
        !byHand &&
        !isKept({ projectPath: agent.agentPath, name: '', displayName: '' }) &&
        chat.runtime !== COMPUTER_LOCAL_RUNTIME &&
        !isChosenMode(declared, stored);
      const before = effectiveMode(declared, stored, modeAt(then), follows);
      const after = effectiveMode(declared, stored, modeAt(now), follows);
      if (looser(declared, before, after)) fell += 1;
      else if (looser(declared, after, before) && !marked) rose += 1;
      else if (byHand && !marked) {
        // Set by hand and left lower by a raise that would have lifted it.
        const lifted = effectiveMode(declared, stored, modeAt(now), true);
        if (looser(declared, lifted, after)) heldByHand += 1;
      }
    }
    return levelReachSentence(rose, fell, heldByHand);
  };
}
