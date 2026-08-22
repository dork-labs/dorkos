/**
 * The small vocabulary every rule shares: what a row's key is, and what a
 * target's interaction key is.
 *
 * Not a rule — spellings that would otherwise be repeated in sixteen files and
 * drift in one of them.
 *
 * @module features/dashboard-sidebar/model/rules/targets
 */
import type { SidebarTarget } from '../build-sidebar-model';
import type { SidebarState } from '../sidebar-state';

/**
 * A row's stable key: `${target.kind}:${id}`.
 *
 * Two arms already carry their prefix in their id — a suggestion's id reads
 * `suggestion:ask-dorkbot` because the same string is its `reason` and its
 * retirement token — so they are used verbatim rather than doubled up.
 *
 * **A thread is keyed by its root entry, not by its room.** A thread and the
 * room it lives in are two rows pointing at one place (BC-15), and two rows may
 * not share a key: they would collide as React children, and — because the
 * active row is found by key — opening one would tint both. Its INTERACTION key
 * is still the room's ({@link interactionKeyOf}), because a thread reads the
 * room's read cursor. Identity and read state are different questions.
 *
 * @param target - What the row points at.
 */
export function rowKey(target: SidebarTarget): string {
  switch (target.kind) {
    case 'session':
      return `session:${target.sessionId}`;
    case 'room':
      return target.roomKind === 'thread' && target.rootEntryId !== undefined
        ? `thread:${target.rootEntryId}`
        : `room:${target.roomId}`;
    case 'agent':
      return `agent:${target.path}`;
    case 'attention':
      return `attention:${target.signalId}`;
    case 'rollup':
      return `rollup:${target.rollup}`;
    case 'suggestion':
      return target.suggestionId;
    case 'digest':
      return 'digest:today';
    case 'command':
      return `command:${target.commandId}`;
  }
}

/**
 * The key this target's interaction timestamps live under
 * (`entities/interactions`), or `null` for a target nobody "opens" — a rollup,
 * a suggestion, the digest.
 *
 * A thread's interactions are the room's: a thread is a relation between
 * entries in one room's log (ADR 260728-022013), and its read cursor is the
 * room's cursor.
 *
 * @param target - What the row points at.
 */
export function interactionKeyOf(target: SidebarTarget): string | null {
  switch (target.kind) {
    case 'session':
      return `session:${target.sessionId}`;
    case 'room':
      return `room:${target.roomId}`;
    case 'agent':
      return `agent:${target.path}`;
    default:
      return null;
  }
}

/**
 * Whether two targets point at the same thing.
 *
 * Compared through {@link rowKey} rather than field by field, so a new arm
 * cannot be added to the union and silently compare as "never equal".
 *
 * @param a - One target.
 * @param b - The other, or `null` when nothing is active.
 */
export function sameTarget(a: SidebarTarget, b: SidebarTarget | null): boolean {
  return b !== null && rowKey(a) === rowKey(b);
}

/**
 * The key of the row the operator has open — the anchor — or `null` when
 * nothing conversational is.
 *
 * Only a session or a room can anchor Today: an agent is a teammate rather than
 * a conversation, and `/marketplace` is not a place Today knows about.
 *
 * It lives beside {@link rowKey} rather than in `pin-active-anchor` because
 * three rules need the answer — selection keeps the anchor eligible whatever
 * else it would drop, archival exempts it, and the cap does too — and a rule
 * importing another rule to ask one question is how a cycle starts.
 *
 * @param state - The snapshot.
 */
export function anchorKey(state: SidebarState): string | null {
  const active = state.activeTarget;
  if (active === null) return null;
  if (active.kind !== 'session' && active.kind !== 'room') return null;
  return rowKey(active);
}

/**
 * Epoch ms for an ISO-8601 instant, or `null` when there is nothing parseable.
 *
 * `null` rather than `NaN` or `0`: "we do not know when" is a fact a sort has
 * to place deliberately, and `NaN` places it wherever the comparator happens to
 * fall through.
 *
 * @param iso - An ISO-8601 timestamp, or nothing.
 */
export function epochMs(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}
