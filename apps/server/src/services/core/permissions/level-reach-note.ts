/**
 * The line a person's change to a level adds to its history entry: how many existing chats the
 * change reaches, from their next turn (DOR-3175). Nothing is rewritten when a
 * level changes; each chat meets it at its next turn's start
 * (`turn-power/agent-level-bound.ts`), so this compares, per chat, the mode its
 * next turn ran at under the old level with the one it runs at under the new.
 *
 * Counted by direction (Security, 2026-10-20):
 *
 * - **Down:** every chat whose next turn now runs lower, marked ones included,
 *   since the cap reaches them too. "14 chats follow it".
 * - **Up:** only chats that really go up, each named (the first ten, then
 *   "+N more"). A marked or held chat's turns stay capped by their marks, so it
 *   is left out; chats a person set by hand keep their own mode and are counted
 *   as staying lower. "12 chats rose (Build, #dorkos, …), 2 set by hand stay
 *   lower".
 *
 * A chat that answers to two agents (its own, standing in another's folder) is
 * held by the stricter of both, as its turns are.
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
  /** A chat's title as a person reads it (a room seat's room), or `null` when it has none. */
  titleOf: (sessionId: string) => Promise<string | null>;
}

/** How many chats that rose the line names before "+N more" (PM, 2026-10-20). */
export const NAMED_RISE_LIMIT = 10;

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
 * The line for the counts, or `undefined` when nothing changes. The chats that
 * rose are named, the first {@link NAMED_RISE_LIMIT} then "+N more", so a
 * person can find and set back any of them (PM, 2026-10-20).
 *
 * @param rose - The titles of the chats whose next turn now runs higher.
 * @param fell - How many chats' next turn now runs lower.
 * @param heldByHand - How many chats set by hand a raise leaves lower.
 */
export function levelReachSentence(
  rose: readonly string[],
  fell: number,
  heldByHand: number
): string | undefined {
  const parts: string[] = [];
  if (fell > 0) parts.push(fell === 1 ? '1 chat follows it' : `${fell} chats follow it`);
  if (rose.length > 0) {
    const shown = rose.slice(0, NAMED_RISE_LIMIT).join(', ');
    const more = rose.length > NAMED_RISE_LIMIT ? ` +${rose.length - NAMED_RISE_LIMIT} more` : '';
    const count = rose.length === 1 ? '1 chat rose' : `${rose.length} chats rose`;
    parts.push(`${count} (${shown}${more})`);
  }
  if (rose.length > 0 && heldByHand > 0) parts.push(`${heldByHand} set by hand stay lower`);
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
    const rose: string[] = [];
    let fell = 0;
    let heldByHand = 0;
    for (const chat of deps.chats()) {
      const agent = deps.agentOf(chat);
      if (agent === undefined || agent === 'unmatched' || !chat.runtime) continue;
      const runtime = chat.runtime;
      const declared = deps.modes(runtime);
      const stored = chat.permissionMode ?? declared?.default;
      if (!declared || !stored) continue;
      // Every agent whose level holds this chat: its own, and the folder's when they differ.
      const agents = [agent.agentPath, ...(agent.alsoBoundBy ? [agent.alsoBoundBy] : [])];
      const now: StopsAt[] = [];
      for (const agentPath of agents) {
        now.push({
          own: await deps.ownStop(agentPath),
          runtime: defaults.perRuntime[runtime] ?? null,
          global: defaults.global,
        });
      }
      const then = now.map((stops) => ({ ...stops }));
      let touched = false;
      for (const change of moves) {
        if (change.key.kind !== 'files') continue;
        const before = (change.before as PermissionStop | null) ?? null;
        for (const [i, agentPath] of agents.entries()) {
          const stops = then[i]!;
          if (change.target.kind === 'agent') {
            if (change.target.agentPath !== agentPath) continue;
            stops.own = before;
          } else if (change.key.runtime !== undefined) {
            if (change.key.runtime !== runtime) continue;
            stops.runtime = before;
          } else {
            stops.global = before;
          }
          touched = true;
        }
      }
      if (!touched) continue;
      /** The stricter of every holding agent's level, as this runtime's mode. */
      const modeAt = (all: StopsAt[]) => {
        const ids = all
          .map((s) => resolveStopMode(s.own ?? s.runtime ?? s.global, declared.values))
          .filter((id): id is string => id !== undefined);
        if (ids.length === 0) return undefined;
        return ids.reduce((a, b) => (looser(declared, a, b) ? b : a));
      };
      const marked = deps.marked(chat.sessionId);
      const byHand = deps.personSet(chat.sessionId);
      const follows =
        agent.exact &&
        !agent.alsoBoundBy &&
        !marked &&
        !byHand &&
        !isKept({ projectPath: agent.agentPath, name: '', displayName: '' }) &&
        runtime !== COMPUTER_LOCAL_RUNTIME &&
        !isChosenMode(declared, stored);
      const before = effectiveMode(declared, stored, modeAt(then), follows);
      const after = effectiveMode(declared, stored, modeAt(now), follows);
      if (looser(declared, before, after)) fell += 1;
      else if (looser(declared, after, before) && !marked) {
        rose.push((await deps.titleOf(chat.sessionId)) ?? 'Untitled chat');
      } else if (byHand && !marked) {
        // Set by hand and left lower by a raise that would have lifted it.
        const lifted = effectiveMode(declared, stored, modeAt(now), true);
        if (looser(declared, lifted, after)) heldByHand += 1;
      }
    }
    return levelReachSentence(rose, fell, heldByHand);
  };
}
