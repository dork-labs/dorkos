/**
 * The durable half of a held connected-app action: the Activity lines a hold
 * writes, and how a later process reads them back (spec
 * `trusted-by-default-flip` §5.6). Split out of `destructive-hold.ts`, which
 * keeps the live state.
 *
 * Every hold writes `connector.destructive_held` when everyone has been told,
 * `connector.destructive_released` the moment its wait ends with nobody
 * cancelling (before the action is sent), and exactly one ending:
 * `_cancelled`, `_executed` or `_dropped`.
 *
 * @module services/connectors/execution/hold-activity
 */
import type { ActivityItem } from '@dorkos/shared/activity-schemas';
import { sessionPath } from '@dorkos/shared/session-link';
import type { ActivityService } from '../../activity/activity-service.js';

/** The Activity event types a hold writes, start to end. */
export const HOLD_EVENT_TYPES = {
  held: 'connector.destructive_held',
  released: 'connector.destructive_released',
  cancelled: 'connector.destructive_cancelled',
  executed: 'connector.destructive_executed',
  dropped: 'connector.destructive_dropped',
} as const;

/** One step of a hold's record. */
export type HoldStep = keyof typeof HOLD_EVENT_TYPES;

/** The agent that asked for a held action, from the turn's verified principal. */
export interface HoldRequester {
  /** The agent's home folder, its stable identity. */
  agentPath: string;
  /** Its Mesh id, when it has one. */
  agentId?: string;
  /** What to call it. */
  name: string;
  /** The chat it asked from. */
  sessionId: string;
}

/** The held action, in the app's own words. Never its arguments. */
export interface HeldActionDescription {
  /** e.g. `Delete message`. */
  actionName: string;
  /** e.g. `Gmail`. */
  serviceName: string;
}

/** One hold, as every line about it names it. */
export interface HoldRecord {
  holdId: string;
  requester: HoldRequester;
  action: HeldActionDescription;
}

/** Who is cancelling a hold. */
export type HoldCanceller =
  | { kind: 'person' }
  | { kind: 'agent'; agentPath: string; name: string; sessionId?: string }
  | { kind: 'unidentified'; sessionId?: string };

/**
 * A canceller's name, as the agent's tool result and the row say it.
 *
 * @param canceller - Who cancelled.
 * @returns Their name in a sentence.
 */
export function cancellerName(canceller: HoldCanceller): string {
  if (canceller.kind === 'agent') return canceller.name;
  return canceller.kind === 'person' ? 'A person' : 'An unidentified caller';
}

/** Who a line names as its actor. */
function actorOf(hold: HoldRecord, step: HoldStep, canceller?: HoldCanceller) {
  if (step === 'cancelled' && canceller) {
    if (canceller.kind === 'agent') {
      return {
        actorType: 'agent' as const,
        actorId: canceller.agentPath,
        actorLabel: canceller.name,
      };
    }
    return canceller.kind === 'person'
      ? { actorType: 'user' as const, actorLabel: 'You' }
      : { actorType: 'system' as const, actorLabel: 'Unidentified caller' };
  }
  if (step === 'dropped' || step === 'cancelled') {
    return { actorType: 'system' as const, actorLabel: 'DorkOS' };
  }
  return {
    actorType: 'agent' as const,
    actorId: hold.requester.agentPath,
    actorLabel: hold.requester.name,
  };
}

/** The line's one sentence. */
function summaryOf(
  hold: HoldRecord,
  step: HoldStep,
  extra: Record<string, unknown>,
  canceller?: HoldCanceller
): string {
  const name = hold.requester.name;
  const phrase = `“${hold.action.actionName}” in ${hold.action.serviceName}`;
  switch (step) {
    case 'held':
      return `${name} will run ${phrase} in 60 seconds unless someone cancels`;
    case 'released':
      return `${name} is running ${phrase}: nobody cancelled it`;
    case 'executed':
      return extra.outcome === 'outcome_unknown'
        ? `${name} may have run ${phrase}: DorkOS couldn’t confirm it finished`
        : `${name} ran ${phrase} after nobody cancelled it`;
    case 'dropped':
      return extra.mayHaveRun
        ? `${name}’s ${phrase} may have run: DorkOS restarted while it ran`
        : `${name}’s ${phrase} did not run: DorkOS restarted first`;
    case 'cancelled':
      if (extra.reason === 'stopped')
        return `${name}’s ${phrase} did not run: the chat stopped first`;
      if (extra.reason === 'changed') {
        return `${name}’s ${phrase} did not run: it no longer qualified to run without asking`;
      }
      if (extra.reason === 'unannounced') {
        return `${name}’s ${phrase} did not run: nobody could be told, so DorkOS asked with a card`;
      }
      return `${canceller ? cancellerName(canceller) : 'Someone'} cancelled ${name}’s ${phrase} before it ran`;
  }
}

/**
 * Write one line of a hold's record to the Activity log. Never throws.
 *
 * @param activity - The Activity log, when wired.
 * @param hold - The hold.
 * @param step - Which line.
 * @param extra - Metadata beside the hold's own.
 * @param canceller - Who cancelled, for a `cancelled` line.
 * @returns Whether the line was saved; `false` with no log wired.
 */
export async function writeHoldLine(
  activity: Pick<ActivityService, 'tryEmit'> | undefined,
  hold: HoldRecord,
  step: HoldStep,
  extra: Record<string, unknown> = {},
  canceller?: HoldCanceller
): Promise<boolean> {
  if (!activity) return false;
  const { requester, action } = hold;
  return activity.tryEmit({
    ...actorOf(hold, step, canceller),
    category: 'agent',
    eventType: HOLD_EVENT_TYPES[step],
    resourceType: 'connector_hold',
    resourceId: hold.holdId,
    resourceLabel: `${action.actionName} in ${action.serviceName}`,
    summary: summaryOf(hold, step, extra, canceller),
    linkPath: sessionPath({ session: requester.sessionId }),
    metadata: {
      holdId: hold.holdId,
      agentPath: requester.agentPath,
      ...(requester.agentId ? { agentId: requester.agentId } : {}),
      agentName: requester.name,
      sessionId: requester.sessionId,
      actionName: action.actionName,
      serviceName: action.serviceName,
      ...extra,
    },
  });
}

/** Rebuild what a `held` line recorded, or nothing when it is unreadable. */
function recordFromMetadata(
  holdId: string,
  metadata: Record<string, unknown> | null
): HoldRecord | undefined {
  const text = (key: string) =>
    typeof metadata?.[key] === 'string' ? (metadata[key] as string) : undefined;
  const agentPath = text('agentPath');
  const name = text('agentName');
  const sessionId = text('sessionId');
  const actionName = text('actionName');
  const serviceName = text('serviceName');
  if (!agentPath || !name || !sessionId || !actionName || !serviceName) return undefined;
  const agentId = text('agentId');
  return {
    holdId,
    requester: { agentPath, name, sessionId, ...(agentId ? { agentId } : {}) },
    action: { actionName, serviceName },
  };
}

/** A hold an earlier process left without an ending, and whether it was sent. */
export interface OpenHold {
  hold: HoldRecord;
  /** Its wait had ended, so its action may have been sent. */
  released: boolean;
}

/**
 * The holds the log shows as started and never ended.
 *
 * Built from sets, never from the order the lines come back in: two lines of
 * one hold can share a millisecond, and an ending must close its hold
 * whichever of the two sorts first.
 *
 * @param events - Every hold line in the window looked at.
 * @param live - Hold ids this process still holds, which are not open.
 * @returns The holds to close.
 */
export function openHoldsFrom(
  events: readonly ActivityItem[],
  live: (holdId: string) => boolean
): OpenHold[] {
  const ended = new Set<string>();
  const released = new Set<string>();
  const held = new Map<string, HoldRecord>();
  for (const event of events) {
    const holdId = event.resourceId;
    if (!holdId) continue;
    if (event.eventType === HOLD_EVENT_TYPES.held) {
      const record = recordFromMetadata(holdId, event.metadata);
      if (record) held.set(holdId, record);
    } else if (event.eventType === HOLD_EVENT_TYPES.released) {
      released.add(holdId);
    } else {
      ended.add(holdId);
    }
  }
  return [...held.values()]
    .filter((hold) => !ended.has(hold.holdId) && !live(hold.holdId))
    .map((hold) => ({ hold, released: released.has(hold.holdId) }));
}
