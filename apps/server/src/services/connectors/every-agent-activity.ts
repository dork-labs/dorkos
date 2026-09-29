/**
 * The Activity trail for every-agent grants (ADR 260926-192625).
 *
 * Two moments leave a record, because both widen what agents can do without a
 * per-agent yes:
 *
 * - the grant itself changing — shared, widened, narrowed or stopped — so a
 *   change nobody made in the app still leaves a trace (with login off DorkOS
 *   cannot tell the app from a program on this computer; the writer says so);
 * - an agent arriving that inherits it, on EVERY arrival path (the create
 *   dialog, `POST /api/agents`, mesh registration, `create_agent`, marketplace
 *   installs, discovery adoption), since only the create dialog can say it
 *   before the agent exists.
 *
 * A third moment is sharing ending as a side effect rather than by choice —
 * the account was disconnected, or its provider moved to a DorkOS account.
 * Those paths run deep in the connection store, long before Activity exists at
 * boot, so they report through one process-wide listener set in `index.ts`,
 * the same trade `services/core/agent-created-hook.ts` makes.
 *
 * @module services/connectors/every-agent-activity
 */
import type { ActivityCategory, ActorType } from '@dorkos/shared/activity-schemas';
import {
  serviceNameFromToolkit,
  type ConnectorOperationClassification,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorEveryAgentGrants } from '@dorkos/shared/connector-resource-schemas';
import { logger } from '../../lib/logger.js';
import type { CreatedAgentInfo } from '../core/agent-created-hook.js';
import type { EndedEveryAgentGrant } from './every-agent-grants.js';

/**
 * Where an Activity row links: that app's side panel on the Connections page,
 * where sharing is changed or stopped, or the page itself when a row names
 * more than one app.
 *
 * @param connectionId - The one connection the row is about, when there is one.
 */
export function everyAgentActivityLink(connectionId?: string): string {
  return connectionId ? `/connections?app=${encodeURIComponent(connectionId)}` : '/connections';
}

/** Event type for a change to what every agent can do with one connection. */
export const EVERY_AGENT_CHANGED_EVENT = 'connectors.every_agent_changed';

/** Event type for a new agent inheriting every-agent grants. */
export const EVERY_AGENT_INHERITED_EVENT = 'connectors.every_agent_inherited';

/** The Activity writer this module needs; `ActivityService` satisfies it. */
export interface EveryAgentActivitySink {
  /** Append one Activity row; never throws. */
  emit(event: {
    actorType: ActorType;
    actorLabel: string;
    actorId?: string | null;
    category: ActivityCategory;
    eventType: string;
    resourceType?: string | null;
    resourceId?: string | null;
    resourceLabel?: string | null;
    summary: string;
    linkPath?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<void> | void;
}

/** Who changed a grant, as the Activity row names them. */
export interface EveryAgentChangeWriter {
  /** Activity actor type. */
  readonly actorType: ActorType;
  /** Name the history shows; "Someone on this computer" when login is off. */
  readonly actorLabel: string;
  /** Stable actor id, when one was proved. */
  readonly actorId?: string;
}

/** One change to a connection's every-agent grant. */
export interface EveryAgentChange {
  /** Stable connection id. */
  readonly connectionId: string;
  /** The service, e.g. `gmail`. */
  readonly toolkit: string;
  /** The owner's label for the account. */
  readonly label: string;
  /** Classifications every agent had before; empty when it was not shared. */
  readonly before: readonly ConnectorOperationClassification[];
  /** Classifications every agent has after; empty when sharing stopped. */
  readonly after: readonly ConnectorOperationClassification[];
  /** Exact action count after the change. */
  readonly operationCount: number;
}

/** A service's display name from its toolkit id; the one rule the app uses too. */
export const serviceName = serviceNameFromToolkit;

/**
 * What a set of classifications lets an agent do, in words: `read`,
 * `read and write`, `read, write and delete`.
 *
 * @param classifications - The classifications of the granted actions.
 */
export function accessWords(classifications: readonly ConnectorOperationClassification[]): string {
  const words = (['read', 'write', 'destructive'] as const)
    .filter((level) => classifications.includes(level))
    .map((level) => (level === 'destructive' ? 'delete' : level));
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Record one change to a connection's every-agent grant. A no-op change (same
 * action count and classifications) records nothing.
 *
 * @param sink - The Activity writer.
 * @param writer - Who made the change, as honestly as DorkOS can say.
 * @param change - The connection and what every agent could do before and after.
 */
export async function recordEveryAgentChange(
  sink: EveryAgentActivitySink,
  writer: EveryAgentChangeWriter,
  change: EveryAgentChange
): Promise<void> {
  const name = `${serviceName(change.toolkit)} (${change.label})`;
  const summary =
    change.after.length === 0
      ? `Stopped sharing ${name} with every agent`
      : change.before.length === 0
        ? `Shared ${name} with every agent, including agents added later: ${accessWords(change.after)}`
        : `Changed what every agent can do with ${name}: ${accessWords(change.after)}`;
  await sink.emit({
    actorType: writer.actorType,
    actorLabel: writer.actorLabel,
    ...(writer.actorId ? { actorId: writer.actorId } : {}),
    category: 'permissions',
    eventType: EVERY_AGENT_CHANGED_EVENT,
    resourceType: 'connection',
    resourceId: change.connectionId,
    resourceLabel: name,
    summary,
    linkPath: everyAgentActivityLink(change.connectionId),
    metadata: {
      connectionId: change.connectionId,
      operationCount: change.operationCount,
      classifications: [...change.after],
    },
  });
}

/**
 * Build the agent-created reaction that says what a new agent inherits. It
 * records one Activity row only when the agent actually inherits something.
 *
 * @param deps - The Activity writer and the owner's live every-agent grants.
 */
export function createEveryAgentArrivalReaction(deps: {
  readonly activity: EveryAgentActivitySink;
  readonly everyAgentGrants: () => ConnectorEveryAgentGrants;
}): (agent: CreatedAgentInfo) => Promise<void> {
  return async (agent) => {
    const { connections } = deps.everyAgentGrants();
    if (connections.length === 0) return;
    const agentName = agent.displayName ?? agent.name;
    const items = connections.map(
      (grant) =>
        `${serviceName(grant.toolkit)} (${grant.label}, ${accessWords(grant.access.classifications)}${
          grant.lifecycle === 'paused' ? ', paused' : ''
        })`
    );
    await deps.activity.emit({
      actorType: 'system',
      actorLabel: 'DorkOS',
      category: 'permissions',
      eventType: EVERY_AGENT_INHERITED_EVENT,
      resourceType: 'agent',
      resourceId: agent.id,
      resourceLabel: agentName,
      summary: `${agentName} can use ${joinNames(items)}, because ${
        connections.length === 1 ? 'it is' : 'they are'
      } shared with every agent`,
      linkPath: everyAgentActivityLink(
        connections.length === 1 ? connections[0]!.connectionId : undefined
      ),
      metadata: {
        connectionIds: connections.map((grant) => grant.connectionId),
      },
    });
  };
}

/** Why sharing with every agent ended without the owner turning it off. */
export type EveryAgentEndedReason = 'disconnected' | 'moved_to_dorkos_account';

/** Reacts to sharing that ended as a side effect of another change. */
export type EveryAgentEndedListener = (
  ended: readonly EndedEveryAgentGrant[],
  reason: EveryAgentEndedReason
) => Promise<void> | void;

let endedListener: EveryAgentEndedListener | null = null;

/**
 * Register the process-wide listener for sharing that ended as a side effect.
 * Set once in `index.ts`; tests may swap in their own and MUST reset to `null`.
 *
 * @param next - The listener, or `null` to clear.
 */
export function setOnEveryAgentEnded(next: EveryAgentEndedListener | null): void {
  endedListener = next;
}

/**
 * Report sharing that just ended. Call AFTER the revoking transaction commits.
 * Never throws and never blocks the caller: a failed record must not undo or
 * fail the disconnect that caused it.
 *
 * @param ended - Connections whose every-agent grant ended.
 * @param reason - What ended it.
 */
export function notifyEveryAgentEnded(
  ended: readonly EndedEveryAgentGrant[],
  reason: EveryAgentEndedReason
): void {
  if (!endedListener || ended.length === 0) return;
  try {
    void Promise.resolve(endedListener(ended, reason)).catch((err: unknown) =>
      logger.warn('[Connectors] Could not record every-agent sharing ending', { err })
    );
  } catch (err) {
    logger.warn('[Connectors] Could not record every-agent sharing ending', { err });
  }
}

/**
 * Build the listener that records one Activity entry per connection whose
 * sharing ended as a side effect.
 *
 * @param activity - The Activity writer.
 */
export function createEveryAgentEndedRecorder(
  activity: EveryAgentActivitySink
): EveryAgentEndedListener {
  return async (ended, reason) => {
    for (const grant of ended) {
      const name = `${serviceName(grant.toolkit)} (${grant.label})`;
      await activity.emit({
        actorType: 'system',
        actorLabel: 'DorkOS',
        category: 'permissions',
        eventType: EVERY_AGENT_CHANGED_EVENT,
        resourceType: 'connection',
        resourceId: grant.connectionId,
        resourceLabel: name,
        summary:
          reason === 'disconnected'
            ? `Stopped sharing ${name} with every agent because the account was disconnected`
            : `Stopped sharing ${name} with every agent because it now connects through your DorkOS account`,
        linkPath: everyAgentActivityLink(grant.connectionId),
        metadata: {
          connectionId: grant.connectionId,
          operationCount: 0,
          classifications: [],
          reason,
        },
      });
    }
  };
}
