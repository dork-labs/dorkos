/**
 * Notices a permission change nobody made through DorkOS.
 *
 * An agent's own settings live in its `.dork/agent.json`, and that file is the
 * source of truth (ADR-0043). So anything that can edit files on this computer,
 * an agent with file tools included, can change them without going through the
 * permission pages. DorkOS cannot stop that, and login does not either. What it
 * can do is notice: every time the permission layer reads an agent's settings,
 * this compares them with the last value DorkOS wrote or saw, and a difference
 * becomes one `permission.changed` event attributed to "Changed outside
 * DorkOS", with the before and after. The change is honoured, because the
 * person may have hand-edited the file on purpose; it is never silent.
 *
 * The comparison, the per-agent lock, the write generations and the last-seen
 * record are {@link OutsideChangeObserver}'s, shared with the observer of an
 * agent's runtime, model and effort (DOR-2337); read its module doc for the
 * guarantees. What lives here is what a permission change IS: the canonical
 * form, the diff by area, action and files, and the history event.
 *
 * @module services/core/permissions/permission-observer
 */
import {
  PERMISSION_AREA_IDS,
  type AgentPermissions,
  type PermissionAreaId,
  type PermissionChange,
  type PermissionState,
} from '@dorkos/shared/permissions';

import type { ActivityService } from '../../activity/activity-service.js';
import {
  OutsideChangeObserver,
  type ObservedAgentRef,
} from '../agent-observation/outside-change-observer.js';
import {
  PERMISSION_CHECK_UNAVAILABLE_EVENT,
  recordPermissionChange,
  type PermissionWriter,
} from './permission-history.js';

/** The writer an out-of-band change is recorded under. */
export const OUTSIDE_WRITER: PermissionWriter = {
  attribution: 'outside',
  actorType: 'system',
  actorLabel: 'Changed outside DorkOS',
};

/** What the observer needs. */
export interface PermissionObserverDeps {
  /** Where the last-seen values are kept, inside DorkOS's data directory. */
  snapshotFile: string;
  /** The registered agent at a project path, or `undefined` when none is. Only a registered agent is observed. */
  agentAt: (agentPath: string) => ObservedAgentRef | undefined;
  /** The area an action belongs to, or `null` for an action with none. */
  areaOfAction: (actionId: string) => PermissionAreaId | null | undefined;
  /** Reads an agent's permissions off its manifest, fresh. */
  read: (agentPath: string) => Promise<AgentPermissions | undefined>;
  /** The Activity writer. */
  activity: Pick<ActivityService, 'emit'> | undefined;
  /** Where a failure to record is reported; recording never fails a read. */
  logger: { warn: (...args: unknown[]) => void };
}

/** A canonical, comparable form of one agent's settings. */
interface Canonical {
  areas: Record<string, PermissionState>;
  actions: Record<string, PermissionState>;
  filesAndCommands: string | null;
}

/** Sort a record's keys so two equal records serialize the same. */
function sorted<T>(record: Record<string, T> | undefined): Record<string, T> {
  return Object.fromEntries(Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

/** Absent and empty settings are the same thing: nothing set. */
function canonical(permissions: AgentPermissions | undefined): Canonical {
  return {
    areas: sorted(permissions?.areas),
    actions: sorted(permissions?.actions),
    filesAndCommands: permissions?.filesAndCommands ?? null,
  };
}

/** True for an area DorkOS knows. */
function isArea(value: string): value is PermissionAreaId {
  return (PERMISSION_AREA_IDS as readonly string[]).includes(value);
}

/**
 * Every key whose value differs between two canonical settings. A key DorkOS
 * does not know (an area that does not exist, an action with no area) changes
 * nothing the gate decides, so it is not reported.
 */
function diff(
  before: Canonical,
  after: Canonical,
  target: PermissionChange['target'],
  areaOfAction: PermissionObserverDeps['areaOfAction']
): PermissionChange[] {
  const changes: PermissionChange[] = [];
  for (const area of new Set([...Object.keys(before.areas), ...Object.keys(after.areas)])) {
    const was = before.areas[area] ?? null;
    const now = after.areas[area] ?? null;
    if (was === now || !isArea(area)) continue;
    changes.push({ target, key: { kind: 'area', area }, before: was, after: now });
  }
  for (const action of new Set([...Object.keys(before.actions), ...Object.keys(after.actions)])) {
    const was = before.actions[action] ?? null;
    const now = after.actions[action] ?? null;
    const area = areaOfAction(action);
    if (was === now || !area) continue;
    changes.push({ target, key: { kind: 'action', action, area }, before: was, after: now });
  }
  if (before.filesAndCommands !== after.filesAndCommands) {
    changes.push({
      target,
      key: { kind: 'files' },
      before: before.filesAndCommands,
      after: after.filesAndCommands,
    });
  }
  return changes;
}

/** What that event says, after the agent's name. */
export const UNCHECKABLE_SUMMARY =
  "DorkOS can't check this agent's settings for outside changes right now";

/** Records permission changes made to an agent's file outside DorkOS. */
export class PermissionObserver extends OutsideChangeObserver<
  AgentPermissions | undefined,
  Canonical
> {
  constructor(deps: PermissionObserverDeps) {
    super({
      snapshotFile: deps.snapshotFile,
      agentAt: deps.agentAt,
      read: deps.read,
      canonical,
      onChange: async ({ agent, agentPath, before, after }) => {
        const changes = diff(
          before,
          after,
          { kind: 'agent', agentId: agent.id, agentPath, agentName: agent.name },
          deps.areaOfAction
        );
        await recordPermissionChange(deps.activity, {
          changes,
          surface: 'file-edit',
          writer: OUTSIDE_WRITER,
        });
      },
      reportUnreadable: async (agent, agentPath) => {
        // Without an Activity writer there is nobody to tell.
        if (!deps.activity) return;
        await deps.activity.emit({
          actorType: 'system',
          actorLabel: 'DorkOS',
          category: 'permissions',
          eventType: PERMISSION_CHECK_UNAVAILABLE_EVENT,
          resourceType: 'agent',
          resourceId: agent.id,
          resourceLabel: agent.name,
          summary: `${agent.name}: ${UNCHECKABLE_SUMMARY}`,
          linkPath: null,
          metadata: { agentPath },
        });
      },
      logger: deps.logger,
      logLabel: '[Permissions]',
    });
  }
}
