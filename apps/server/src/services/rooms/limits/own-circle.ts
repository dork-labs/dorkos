/**
 * Marks, not levels, between the owner's own agents (DOR-3107, Security).
 *
 * A room turn woken by one of the owner's agents used to be held to the level
 * the poster's turn ran at. That level lived only in memory, so after a
 * restart, or once one turn ran at Default, every turn after it in the room ran
 * at Default too: most of the approval cards a person saw. What carries a risk
 * is not the poster's level but whether its turn read words from outside the
 * owner's circle, and that is what a post's stored marks say.
 *
 * So in a room that is the owner's own circle (decided on every turn), a post
 * KNOWN to carry no mark hands on no ceiling, and the woken agent runs at its
 * own level, unless the person set the poster itself below Full autonomy, in
 * which case its posts are held to the poster's own level. Everything else is
 * as before: a post nobody can vouch for (no stored marks), a marked post, a
 * bridged or space room, or an outsider's words in view.
 *
 * @module services/rooms/limits/own-circle
 */
import type { RoomContextData } from '@dorkos/shared/additional-context';
import type { TurnPermissionBound } from '@dorkos/shared/agent-runtime';
import { levelOfMode } from '@dorkos/shared/permission-semantics';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { entryMarksOf } from '../../core/turn-power/turn-levels.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import {
  readAgentExecutionDefaults,
  resolveUnattendedPermissionMode,
} from '../../session/resolution/resolve-session-defaults.js';
import type { AuthorRegistry } from '../author-registry.js';
import { outsiderInViewOf } from './turn-ceiling.js';

/** What decides an own-circle turn, read where the turn is built. */
export interface OwnCircle {
  /** The room holds only the owner and their own agents, and nothing unvouched is in view. */
  ownCircle: boolean;
  /** The cap the person set on a poster below Full autonomy, by author id. */
  posterCap?: (authorId: string) => TurnPermissionBound | undefined;
}

/**
 * Whether a room turn is in the owner's own circle: not a space room, no
 * bridge, no outsider's words in view, and no agent post in view whose marks
 * nobody kept. Checked on every turn.
 *
 * @param context - What the turn is about to be shown.
 * @param roomId - The room.
 * @param room - Whether it is a space room, and whether it is bridged.
 */
export function isOwnCircle(
  context: Pick<RoomContextData, 'pending' | 'gathered' | 'channelTail'>,
  roomId: string,
  room: { inSpaceRoom: boolean; bridged: boolean }
): boolean {
  if (room.inSpaceRoom || room.bridged) return false;
  if (outsiderInViewOf(context, roomId).outsiderInView) return false;
  const shown = [...context.pending, ...(context.gathered ?? []), ...(context.channelTail ?? [])];
  // An agent's post with no stored marks could carry anything: the strict side.
  return !shown.some(
    (entry) =>
      !entry.authorIsPerson && entry.kind === 'post' && entryMarksOf(entry.id, roomId) === null
  );
}

/**
 * The level a person set a poster to, when it is below Full autonomy: its own
 * Files & commands stop, else its runtime's, else everyone's, read as the
 * runtime's mode. An answer that cannot be worked out is the runtime's
 * default, the strict side.
 *
 * @param agentPath - The poster's folder.
 */
export async function posterLevel(agentPath: string): Promise<TurnPermissionBound> {
  try {
    const defaults = await readAgentExecutionDefaults(agentPath);
    const type =
      defaults.runtime && runtimeRegistry.has(defaults.runtime)
        ? defaults.runtime
        : runtimeRegistry.getDefaultType();
    const capabilities = runtimeRegistry.getAllCapabilities()[type];
    const mode = resolveUnattendedPermissionMode({
      capabilities,
      ...(defaults.filesAndCommands
        ? { agent: { filesAndCommands: defaults.filesAndCommands } }
        : {}),
    });
    const level = capabilities ? levelOfMode(capabilities.permissionModes, mode) : undefined;
    return level ?? 'runtime-default';
  } catch {
    return 'runtime-default';
  }
}

/**
 * Each answered agent author's own cap, read ahead of the synchronous ceiling.
 *
 * @param authors - The registry holding the stored author records.
 * @param entries - Every message the turn answers.
 * @param read - Reads one poster's level (tests pass their own).
 */
export async function posterCapsFor(
  authors: AuthorRegistry,
  entries: readonly Pick<RoomEntry, 'authorId'>[],
  read: ((agentPath: string) => Promise<TurnPermissionBound>) | undefined = posterLevel
): Promise<(authorId: string) => TurnPermissionBound | undefined> {
  const ids = [...new Set(entries.map((entry) => entry.authorId))];
  const records = authors.getMany(ids);
  const caps = new Map<string, TurnPermissionBound>();
  for (const id of ids) {
    const record = records.get(id);
    if (record?.kind !== 'agent') continue;
    caps.set(id, await (read ?? posterLevel)(record.naturalKey));
  }
  return (authorId) => caps.get(authorId);
}
