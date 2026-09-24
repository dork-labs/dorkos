/**
 * The audit half of the permission model (spec `agent-permissions` D14): how a
 * permission change is written to the Activity log, who it is attributed to, and
 * how the history is read back.
 *
 * Every write lands as exactly ONE `permission.changed` event in the
 * `permissions` category, a bulk write included: the default change and every
 * agent it touched are all rows of `metadata.changes`. That category is kept past
 * the 30-day prune, because a history that forgets cannot answer "who allowed
 * this".
 *
 * ## The honesty rule for who made a change
 *
 * With login off DorkOS cannot tell the person at the keyboard from any other
 * program running as the same user, so a person's write is labelled "Someone on
 * this computer", never "You", and the history says why. With login on it names
 * the signed-in account. An upgrade step is "Upgrade".
 *
 * @module services/core/permissions/permission-history
 */
import {
  PERMISSION_ANSWERED_EVENT,
  PERMISSION_CHANGED_EVENT,
  PermissionAnsweredMetadataSchema,
  PermissionChangedMetadataSchema,
  getPermissionArea,
  type PermissionAttribution,
  type PermissionChange,
  type PermissionChangedMetadata,
  type PermissionHistoryEntry,
  type PermissionHistoryResponse,
  type PermissionSurface,
} from '@dorkos/shared/permissions';
import type { ActorType } from '@dorkos/shared/activity-schemas';

import type { ActivityService } from '../../activity/activity-service.js';

/** Who made a permission change, as the Activity row records it. */
export interface PermissionWriter {
  /** How sure DorkOS is about who it was. */
  attribution: PermissionAttribution;
  /** The Activity actor type. */
  actorType: ActorType;
  /** The name the history shows. */
  actorLabel: string;
  /** A stable id for the actor, when there is one. */
  actorId?: string;
}

/** The label a login-off person write carries. Never "You": nobody proved it. */
const LOCAL_TRUST_ACTOR_LABEL = 'Someone on this computer';

/** The honesty line a login-off write carries in the history. */
const LOCAL_TRUST_ACTOR_DETAIL = "Login is off, so DorkOS can't confirm who made this change.";

/** The writer every upgrade step records. */
export const UPGRADE_WRITER: PermissionWriter = {
  attribution: 'upgrade',
  actorType: 'system',
  actorLabel: 'Upgrade',
};

/**
 * The writer for a person's change, from the posture the person bars reported.
 *
 * @param posture - `local-trust` with login off, `signed-in-operator` with it on.
 * @param signedIn - The signed-in account, when login is on.
 */
export function personWriter(
  posture: 'local-trust' | 'signed-in-operator',
  signedIn?: { id: string; name: string }
): PermissionWriter {
  if (posture === 'local-trust' || !signedIn) {
    return { attribution: 'local-trust', actorType: 'user', actorLabel: LOCAL_TRUST_ACTOR_LABEL };
  }
  return {
    attribution: 'signed-in',
    actorType: 'user',
    actorId: signedIn.id,
    actorLabel: `You (signed in as ${signedIn.name})`,
  };
}

/** How a state reads in a sentence. */
function stateWord(value: string | null): string {
  switch (value) {
    case 'allowed':
      return 'Allowed';
    case 'ask':
      return 'Ask';
    case 'blocked':
      return 'Blocked';
    case 'careful':
      return 'Careful';
    case 'balanced':
      return 'Balanced';
    case 'full':
      return 'Full power';
    default:
      return value ?? 'default';
  }
}

/** What one change is about, in words: an area label, an action title, the preset. */
function subjectOf(change: PermissionChange, actionTitle: (id: string) => string): string {
  switch (change.key.kind) {
    case 'preset':
      return 'The preset';
    case 'area':
      return getPermissionArea(change.key.area)?.label ?? change.key.area;
    case 'action':
      return actionTitle(change.key.action);
    case 'files':
      return 'Files & commands';
  }
}

/**
 * One plain sentence for a single change.
 *
 * @param change - The change.
 * @param actionTitle - Names an action id the way the permissions page does.
 */
function describeOne(change: PermissionChange, actionTitle: (id: string) => string): string {
  const subject = subjectOf(change, actionTitle);
  if (change.target.kind === 'default') {
    if (change.key.kind === 'preset') return `Preset set to ${stateWord(change.after)}`;
    return change.after === null
      ? `${subject} set back to the preset for everyone`
      : `${subject} set to ${stateWord(change.after)} for everyone`;
  }
  return change.after === null
    ? `${change.target.agentName}: ${subject} back to the default`
    : `${change.target.agentName}: ${subject} ${stateWord(change.after)}`;
}

/**
 * The one-line summary an Activity row shows for a write, e.g. "Rooms set to
 * Allowed for everyone, and 2 agents updated".
 *
 * @param changes - Every change the write made, default rows first.
 * @param actionTitle - Names an action id the way the permissions page does.
 */
function describePermissionChanges(
  changes: readonly PermissionChange[],
  actionTitle: (id: string) => string = (id) => id
): string {
  if (changes.length === 0) return 'No permission changed';
  const defaults = changes.filter((c) => c.target.kind === 'default');
  const agentIds = new Set(
    changes.flatMap((c) => (c.target.kind === 'agent' ? [c.target.agentId] : []))
  );
  if (defaults.length === 0) {
    const [first] = changes;
    const rest = changes.length - 1;
    const head = describeOne(first!, actionTitle);
    if (agentIds.size > 1) return `${head}, and ${agentIds.size - 1} more agents updated`;
    return rest > 0 ? `${head}, and ${rest} more ${rest === 1 ? 'change' : 'changes'}` : head;
  }
  const head = describeOne(defaults[0]!, actionTitle);
  const moreDefaults = defaults.length - 1;
  const parts = [head];
  if (moreDefaults > 0) {
    parts.push(`${moreDefaults} more ${moreDefaults === 1 ? 'change' : 'changes'}`);
  }
  if (agentIds.size > 0) {
    parts.push(`${agentIds.size} ${agentIds.size === 1 ? 'agent' : 'agents'} updated`);
  }
  return parts.length === 1 ? head : `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}

/** Everything one permission write records. */
export interface PermissionChangeRecord {
  /** Every change the write made. */
  changes: PermissionChange[];
  /** Where the write came from. */
  surface: PermissionSurface;
  /** Who made it. */
  writer: PermissionWriter;
  /** Names an action id for the summary. */
  actionTitle?: (id: string) => string;
  /** What the preset, defaults and trust stop were before a preset write. */
  presetSnapshot?: PermissionChangedMetadata['presetSnapshot'];
  /** The approval an agent request was answered through (phase 2). */
  approvalId?: string;
}

/**
 * Write one `permission.changed` event for a permission write. Records nothing
 * for a write that changed nothing.
 *
 * `resourceId` is the agent id when every change targets that one agent, so the
 * per-agent history is a query; a default or bulk change leaves it unset and
 * {@link listPermissionHistory} matches it through `changes[].target`.
 *
 * @param activity - The Activity writer; absent in a process that has none.
 * @param record - The changes, surface and writer.
 */
export async function recordPermissionChange(
  activity: Pick<ActivityService, 'emit'> | undefined,
  record: PermissionChangeRecord
): Promise<void> {
  if (!activity || record.changes.length === 0) return;
  const agentTargets = new Set(
    record.changes.flatMap((c) => (c.target.kind === 'agent' ? [c.target.agentId] : []))
  );
  const onlyAgent =
    agentTargets.size === 1 && record.changes.every((c) => c.target.kind === 'agent')
      ? [...agentTargets][0]
      : undefined;
  const firstAgent = record.changes.find((c) => c.target.kind === 'agent')?.target;
  const metadata: PermissionChangedMetadata = {
    changes: record.changes,
    surface: record.surface,
    attribution: record.writer.attribution,
    ...(record.approvalId ? { approvalId: record.approvalId } : {}),
    ...(record.presetSnapshot ? { presetSnapshot: record.presetSnapshot } : {}),
  };
  await activity.emit({
    actorType: record.writer.actorType,
    actorLabel: record.writer.actorLabel,
    ...(record.writer.actorId ? { actorId: record.writer.actorId } : {}),
    category: 'permissions',
    eventType: PERMISSION_CHANGED_EVENT,
    resourceType: onlyAgent ? 'agent' : 'permissions',
    resourceId: onlyAgent ?? null,
    resourceLabel: onlyAgent && firstAgent?.kind === 'agent' ? firstAgent.agentName : 'Everyone',
    summary: describePermissionChanges(record.changes, record.actionTitle),
    linkPath: null,
    metadata: metadata as unknown as Record<string, unknown>,
  });
}

/**
 * The Activity event one standing permission ended at upgrade is recorded as
 * (`ended-standing-grants.ts`). Not a `permission.changed`: a standing
 * permission was never a permission SETTING (it had no area and no state), so it
 * has no place in a change's key. It lives in the `permissions` category, so it
 * shows in the permission history.
 */
export const STANDING_GRANT_ENDED_EVENT = 'permission.standing_grant_ended';

/** The honesty line a change DorkOS noticed rather than made carries. */
const OUTSIDE_ACTOR_DETAIL =
  "This agent's settings file was edited directly. DorkOS follows the file, so the change is in effect.";

/**
 * The Activity event the permission observer records, once per agent per
 * episode, while its record of last-seen settings cannot be read. It changes
 * no permission, so it is not a `permission.changed`, but it belongs in the
 * history: it is the one line that says the "Changed outside DorkOS" check is
 * not running.
 */
export const PERMISSION_CHECK_UNAVAILABLE_EVENT = 'permission.check_unavailable';

/** The honesty line that event carries. */
const UNCHECKABLE_ACTOR_DETAIL =
  "DorkOS's record of this agent's last-seen settings can't be read, so an edit made outside DorkOS won't be noticed until it can.";

/** The extra line a history row shows under its actor. */
function actorDetailFor(attribution: PermissionAttribution): string | null {
  if (attribution === 'local-trust') return LOCAL_TRUST_ACTOR_DETAIL;
  if (attribution === 'outside') return OUTSIDE_ACTOR_DETAIL;
  return null;
}

/** How many rows the history scans per page while filtering for one agent. */
const SCAN_PAGE = 100;

/**
 * Read the permission history, newest first.
 *
 * With `agentId`, returns the events about that agent: single-agent events by
 * their `resourceId`, and default or bulk events whose `changes` touched it. The
 * category is low volume, so the filter runs over pages of the category rather
 * than a JSON query.
 *
 * @param activity - The Activity reader.
 * @param query - Optional agent, cursor and page size.
 */
export async function listPermissionHistory(
  activity: Pick<ActivityService, 'list'>,
  query: { agentId?: string; before?: string; limit: number }
): Promise<PermissionHistoryResponse> {
  const items: PermissionHistoryEntry[] = [];
  let cursor = query.before;
  let exhausted = false;
  while (items.length < query.limit && !exhausted) {
    const page = await activity.list({
      limit: SCAN_PAGE,
      categories: 'permissions',
      ...(cursor ? { before: cursor } : {}),
    });
    for (const row of page.items) {
      cursor = row.occurredAt;
      if (row.eventType === PERMISSION_CHECK_UNAVAILABLE_EVENT) {
        if (query.agentId && row.resourceId !== query.agentId) continue;
        items.push({
          id: row.id,
          occurredAt: row.occurredAt,
          actorLabel: row.actorLabel,
          actorDetail: UNCHECKABLE_ACTOR_DETAIL,
          summary: row.summary,
          // A notice, not a change: no rows, and the outside-check's own labels.
          metadata: { changes: [], surface: 'file-edit', attribution: 'outside' },
        });
        if (items.length === query.limit) break;
        continue;
      }
      if (row.eventType === STANDING_GRANT_ENDED_EVENT) {
        // An upgrade line, not a change to a setting: a standing permission had
        // no area and no state, so it carries no `changes` rows.
        if (query.agentId && row.resourceId !== query.agentId) continue;
        items.push({
          id: row.id,
          occurredAt: row.occurredAt,
          actorLabel: row.actorLabel,
          actorDetail: null,
          summary: row.summary,
          metadata: { changes: [], surface: 'upgrade', attribution: 'upgrade' },
        });
        if (items.length === query.limit) break;
        continue;
      }
      if (row.eventType === PERMISSION_ANSWERED_EVENT) {
        // An answer on a request card. Its own `permission.changed` row (for an
        // Always allow) sits beside it; this one records the answer itself.
        const answered = PermissionAnsweredMetadataSchema.safeParse(row.metadata);
        if (!answered.success) continue;
        if (query.agentId && row.resourceId !== query.agentId) continue;
        const attribution: PermissionAttribution =
          answered.data.posture === 'signed-in-operator' ? 'signed-in' : 'local-trust';
        items.push({
          id: row.id,
          occurredAt: row.occurredAt,
          actorLabel: row.actorLabel,
          actorDetail: actorDetailFor(attribution),
          summary: row.summary,
          metadata: {
            changes: [],
            surface: 'request-card',
            attribution,
            approvalId: answered.data.approvalId,
          },
        });
        if (items.length === query.limit) break;
        continue;
      }
      if (row.eventType !== PERMISSION_CHANGED_EVENT) continue;
      const parsed = PermissionChangedMetadataSchema.safeParse(row.metadata);
      if (!parsed.success) continue;
      if (query.agentId && !touchesAgent(row.resourceId, parsed.data, query.agentId)) continue;
      items.push({
        id: row.id,
        occurredAt: row.occurredAt,
        actorLabel: row.actorLabel,
        actorDetail: actorDetailFor(parsed.data.attribution),
        summary: row.summary,
        metadata: parsed.data,
      });
      if (items.length === query.limit) break;
    }
    exhausted = page.nextCursor === null;
  }
  // A full page may be followed by an empty one; that costs a reader one extra
  // request and never hides a row.
  const last = items.at(-1);
  return { items, nextCursor: items.length === query.limit && last ? last.occurredAt : null };
}

/** Whether a permission event is about one agent. */
function touchesAgent(
  resourceId: string | null,
  metadata: PermissionChangedMetadata,
  agentId: string
): boolean {
  if (resourceId === agentId) return true;
  return metadata.changes.some((c) => c.target.kind === 'agent' && c.target.agentId === agentId);
}
