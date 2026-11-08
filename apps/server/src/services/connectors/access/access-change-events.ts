/**
 * What DorkOS records and tells the person when an agent takes connection
 * access away, or a person undoes it (spec `agent-grant-autonomy` §8).
 *
 * Three outputs, none of which carries the agent's reason: the audit trail,
 * an Activity row, and, for another agent's access only, a Needs-you item with
 * Undo (Security G2). The reason is the agent's own words, so it stays on the
 * ledger row and only the person's routes read it back (Security, 11:27 CT);
 * Activity and notifications are places agents read too.
 *
 * Copy says what is true and no more: a left-out agent can't use the app
 * directly. It can still ask another agent to, so nothing here says otherwise.
 *
 * @module services/connectors/access/access-change-events
 */
import { recordAudit } from '../../audit/audit-trail.js';
import { notify } from '../../notifications/notification-service.js';
import {
  everyAgentActivityLink,
  serviceName,
  type EveryAgentActivitySink,
} from '../every-agent-activity.js';
import type { GrantChangeKind } from '@dorkos/db';
import type { AccessState } from './access-state.js';

/** Event type for an agent-made access change, and for its undo. */
export const ACCESS_CHANGE_EVENT = 'connectors.access_changed';

/** One applied change, in the words the person reads. */
export interface DescribedAccessChange {
  readonly changeId: string;
  readonly kind: GrantChangeKind;
  readonly actorAgentId: string;
  readonly targetAgentId: string;
  readonly connectionId: string;
  readonly appName: string;
  /** The sentence for Activity and the Needs-you title, with agent ids for names. */
  readonly summary: (name: (agentId: string) => string) => string;
  /** Whether the person gets a Needs-you item (another agent's access only). */
  readonly needsYou: boolean;
}

/** What the narrowing service hands its events. */
export interface AccessChangeEvents {
  /** A change was applied. */
  changed(change: DescribedAccessChange): void;
  /** A person undid one. */
  undone(input: {
    changeId: string;
    undoId: string;
    actorAgentId: string;
    targetAgentId: string;
    app: { id: string; toolkit: string; label: string };
  }): void;
  /** A change was refused (written to the ledger already). */
  refused(input: {
    code: string;
    actorAgentId: string;
    targetAgentId: string;
    connectionId: string;
  }): void;
}

/**
 * Describe an applied change for the person.
 *
 * @param input - The change and the app it was on.
 */
export function describeAccessChange(input: {
  changeId: string;
  kind: GrantChangeKind;
  actorAgentId: string;
  targetAgentId: string;
  app: { id: string; toolkit: string; label: string };
  before: AccessState;
  after: AccessState;
}): DescribedAccessChange {
  const appName = `${serviceName(input.app.toolkit)} (${input.app.label})`;
  const lowered = input.after.level === 'read' && input.before.level !== 'read';
  return {
    changeId: input.changeId,
    kind: input.kind,
    actorAgentId: input.actorAgentId,
    targetAgentId: input.targetAgentId,
    connectionId: input.app.id,
    appName,
    needsYou: input.kind === 'narrow_other' || input.kind === 'exclude_other',
    summary: (name) => {
      const actor = name(input.actorAgentId);
      const target = name(input.targetAgentId);
      switch (input.kind) {
        case 'exclude_own':
          return `${actor} left itself out of sharing ${appName} with every agent`;
        case 'exclude_other':
          return `${actor} left ${target} out of sharing ${appName} with every agent`;
        case 'narrow_own':
          return lowered
            ? `${actor} lowered its own ${appName} access to Read`
            : `${actor} gave up some of its ${appName} access`;
        default:
          return lowered
            ? `${actor} lowered ${target}'s ${appName} access to Read`
            : `${actor} took ${appName} access away from ${target}`;
      }
    },
  };
}

/**
 * The live events: audit, Activity and Needs-you.
 *
 * @param deps - The Activity writer, and how to name an agent.
 */
export function createAccessChangeEvents(deps: {
  readonly activity?: EveryAgentActivitySink;
  readonly agentName: (agentId: string) => string;
}): AccessChangeEvents {
  return {
    changed(change) {
      const summary = change.summary(deps.agentName);
      recordAudit({
        action: 'connectors.access_narrow',
        operation: 'modify',
        target: { type: 'connection', id: change.connectionId, name: change.appName },
        outcome: 'ok',
        change: [
          { field: 'agent', after: change.targetAgentId },
          { field: 'kind', after: change.kind },
          { field: 'changeId', after: change.changeId },
        ],
        summary,
      });
      void deps.activity?.emit({
        actorType: 'agent',
        actorLabel: deps.agentName(change.actorAgentId),
        actorId: change.actorAgentId,
        category: 'permissions',
        eventType: ACCESS_CHANGE_EVENT,
        resourceType: 'connection',
        resourceId: change.connectionId,
        resourceLabel: change.appName,
        summary,
        linkPath: everyAgentActivityLink(change.connectionId),
        metadata: {
          changeId: change.changeId,
          kind: change.kind,
          targetAgentId: change.targetAgentId,
        },
      });
      if (change.needsYou) {
        void notify('connector.access_narrowed', {
          changeId: change.changeId,
          connectionId: change.connectionId,
          actorAgentId: change.actorAgentId,
          targetAgentId: change.targetAgentId,
          title: summary,
        });
      }
    },
    undone(input) {
      const appName = `${serviceName(input.app.toolkit)} (${input.app.label})`;
      const summary = `Put back ${deps.agentName(input.targetAgentId)}'s ${appName} access, changed by ${deps.agentName(input.actorAgentId)}`;
      recordAudit({
        action: 'connectors.access_undo',
        operation: 'modify',
        target: { type: 'connection', id: input.app.id, name: appName },
        outcome: 'ok',
        change: [
          { field: 'changeId', after: input.changeId },
          { field: 'undoId', after: input.undoId },
        ],
        summary,
      });
      void deps.activity?.emit({
        actorType: 'user',
        actorLabel: 'You',
        category: 'permissions',
        eventType: ACCESS_CHANGE_EVENT,
        resourceType: 'connection',
        resourceId: input.app.id,
        resourceLabel: appName,
        summary,
        linkPath: everyAgentActivityLink(input.app.id),
        metadata: { changeId: input.changeId, undoId: input.undoId, kind: 'undo' },
      });
    },
    refused(input) {
      recordAudit({
        action: 'connectors.access_narrow',
        operation: 'modify',
        target: { type: 'connection', id: input.connectionId },
        outcome: 'refused',
        error: input.code,
        change: [{ field: 'agent', after: input.targetAgentId }],
        summary: `Refused ${deps.agentName(input.actorAgentId)}'s change to ${deps.agentName(input.targetAgentId)}'s access (${input.code})`,
      });
    },
  };
}
