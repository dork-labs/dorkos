/**
 * The limits a queued message's turn carried only in memory (DOR-4350): an outsider mark, a
 * ceiling, and whether nobody is watching it. An agent's post over HTTP and a heartbeat queue such
 * turns. Kept on the queue row so a pause, a resume and a restart hand them back unchanged, rather
 * than falling back to the runtime's default with the mark lost.
 *
 * @module services/session/message-dispatcher/carried-limits
 */
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { logger } from '../../../lib/logger.js';

/** What a queued message's turn carried, as its row keeps it. */
export interface QueuedCarriedLimits {
  /** The turn read words DorkOS cannot vouch for. Marks, lowers nothing. */
  readonly outsider?: true;
  /** The loosest level the turn may run at. */
  readonly ceiling?: TurnPermissionCeiling;
  /** Nobody is watching the turn, so a card it raises has nobody to answer it. */
  readonly unattended?: true;
}

/** What a row reads as when its stored limits can't be read: marked, held to the default. */
const UNREADABLE: QueuedCarriedLimits = { outsider: true, ceiling: 'runtime-default' };

/**
 * The limits a turn carries, as a row keeps them, or `undefined` for none.
 *
 * @param turn - The turn's own limits.
 */
export function queuedLimitsOf(turn: {
  carriedMarks?: { readonly outsider?: true };
  permissionCeiling?: TurnPermissionCeiling;
  unattended?: boolean;
}): QueuedCarriedLimits | undefined {
  const limits: { outsider?: true; ceiling?: TurnPermissionCeiling; unattended?: true } = {};
  if (turn.carriedMarks?.outsider === true) limits.outsider = true;
  if (turn.permissionCeiling !== undefined) limits.ceiling = turn.permissionCeiling;
  if (turn.unattended === true) limits.unattended = true;
  return Object.keys(limits).length > 0 ? limits : undefined;
}

/**
 * A turn's own ceiling with the one its row kept: every bound of both, so neither loosens the
 * other, each bound once (the row usually kept the plan's own). `undefined` when neither has one.
 *
 * @param own - The ceiling the launching plan carries.
 * @param kept - The ceiling the row kept.
 */
export function withKeptCeiling(
  own: TurnPermissionCeiling | undefined,
  kept: TurnPermissionCeiling | undefined
): TurnPermissionCeiling | undefined {
  if (own === undefined || kept === undefined) return own ?? kept;
  if (JSON.stringify(own) === JSON.stringify(kept)) return own;
  const bounds = (ceiling: TurnPermissionCeiling) => (Array.isArray(ceiling) ? ceiling : [ceiling]);
  const seen = new Set(bounds(own).map((bound) => JSON.stringify(bound)));
  const added = bounds(kept).filter((bound) => !seen.has(JSON.stringify(bound)));
  return added.length === 0 ? own : ([...bounds(own), ...added] as TurnPermissionCeiling);
}

/**
 * The stored cell for a row's limits.
 *
 * @param limits - The limits, or none.
 */
export function serializeQueuedLimits(
  limits: QueuedCarriedLimits | null | undefined
): string | null {
  return limits ? JSON.stringify(limits) : null;
}

const ASKS: ReadonlySet<unknown> = new Set(['always', 'when-risky', 'never']);
const REACH: ReadonlySet<unknown> = new Set(['read', 'edit', 'workspace', 'everything']);

/**
 * Whether a stored value has the shape of a ceiling DorkOS wrote: a known level, or the runtime's
 * default, or a non-empty list of them.
 */
function isCeiling(value: unknown): value is TurnPermissionCeiling {
  const isBound = (bound: unknown) =>
    bound === 'runtime-default' ||
    (typeof bound === 'object' &&
      bound !== null &&
      ASKS.has((bound as { asks?: unknown }).asks) &&
      REACH.has((bound as { reach?: unknown }).reach));
  return Array.isArray(value) ? value.length > 0 && value.every(isBound) : isBound(value);
}

/**
 * Read a row's stored limits. An unreadable cell is not "no limits": it reads as marked and held
 * to the runtime's default, the strict answer.
 *
 * @param stored - The stored cell.
 * @param messageId - The row, for the log line.
 */
export function parseQueuedLimits(
  stored: string | null,
  messageId: string
): QueuedCarriedLimits | null {
  if (stored === null) return null;
  try {
    const value = JSON.parse(stored) as Record<string, unknown>;
    if (typeof value === 'object' && value !== null) {
      const ceiling = value.ceiling;
      if (ceiling === undefined || isCeiling(ceiling)) {
        return {
          ...(value.outsider === true ? { outsider: true as const } : {}),
          ...(ceiling !== undefined ? { ceiling } : {}),
          ...(value.unattended === true ? { unattended: true as const } : {}),
        };
      }
    }
  } catch {
    // fall through to the strict answer below
  }
  logger.warn('[MessageQueueStore] unreadable limits on a queued message', { messageId });
  return UNREADABLE;
}
