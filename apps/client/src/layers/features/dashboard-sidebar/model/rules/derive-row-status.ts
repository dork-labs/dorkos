/**
 * What dot a row wears — derived from lifecycle, never from a verb.
 *
 * @module features/dashboard-sidebar/model/rules/derive-row-status
 */
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import type { IdentityStatus } from '@/layers/shared/ui';

/** What {@link deriveRowStatus} needs to know about one row's subject. */
export interface RowStatusInput {
  /** The session's coarse lifecycle, when the row is a session. */
  lifecycle?: SessionLifecycle;
  /** How many agents are working in this room, when the row is a room. */
  workingCount?: number;
  /** Whether this row's subject is blocked on the operator. */
  needsYou?: boolean;
}

/**
 * The corner dot for one row.
 *
 * **`working` is about this second, never this hour.** It means a turn is
 * streaming as you look at it — which is why the only inputs are the lifecycle
 * the stream reports and the room's live working count, and never a heartbeat,
 * a "seen recently" or a health status. The dot spent a release saying those
 * were the same thing (design-decisions §6).
 *
 * `interrupted` reads as `error` rather than `idle`: a turn that stopped
 * without finishing is a thing that went wrong, and a row that draws nothing
 * for it tells the operator their agent is fine.
 *
 * @param input - What is known about the row's subject.
 */
export function deriveRowStatus(input: RowStatusInput): IdentityStatus {
  if (input.needsYou) return 'needs-you';
  if (input.lifecycle === 'streaming') return 'working';
  if (input.lifecycle === 'blocked') return 'needs-you';
  if (input.lifecycle === 'error' || input.lifecycle === 'interrupted') return 'error';
  if ((input.workingCount ?? 0) > 0) return 'working';
  return 'idle';
}
