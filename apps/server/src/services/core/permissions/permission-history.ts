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
  PERMISSION_SUGGESTION_DISMISSED_EVENT,
  PERMISSION_SUGGESTION_RESTORED_EVENT,
  PermissionAnsweredMetadataSchema,
  PermissionChangedMetadataSchema,
  PermissionSuggestionDismissedMetadataSchema,
  PermissionSuggestionRestoredMetadataSchema,
  getPermissionArea,
  type PermissionAttribution,
  type PermissionChange,
  type PermissionChangedMetadata,
  type PermissionHistoryEntry,
  type PermissionAreaId,
  type PermissionHistoryResponse,
  type PermissionLastChange,
  type PermissionSource,
  type PermissionSurface,
} from '@dorkos/shared/permissions';
import type { ActivityItem, ActorType } from '@dorkos/shared/activity-schemas';

import type { ActivityService } from '../../activity/activity-service.js';
import { isArrivalScreenLine } from './permission-values.js';

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

/**
 * The writer for a change an agent asked for with `change_permission` and a
 * person approved on its card: "DorkBot asked, you said yes" (spec
 * `agent-permissions` D14). The person's yes is what made the change; the name
 * says whose idea it was.
 *
 * @param agent - The agent that asked, by the name a person knows it by.
 */
export function agentRequestWriter(agent: { id?: string; name: string }): PermissionWriter {
  return {
    attribution: 'agent-request-approved',
    actorType: 'agent',
    ...(agent.id ? { actorId: agent.id } : {}),
    actorLabel: `${agent.name} asked, you said yes`,
  };
}

/** How a Files & commands stop reads in a sentence. */
const STOP_WORD: Record<string, string> = {
  ask: 'Ask first',
  act: 'Act',
  autonomy: 'Full autonomy',
};

/**
 * How a recorded value reads in a sentence, by what its key is: `ask` is the
 * state Ask for an area and the stop Ask first for Files & commands.
 */
function valueWord(value: string | null, key: PermissionChange['key']): string {
  if (key.kind === 'files' && value !== null) return STOP_WORD[value] ?? value;
  return stateWord(value);
}

/** How a state or a preset reads in a sentence. */
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
    if (change.key.kind === 'preset') return `Preset set to ${valueWord(change.after, change.key)}`;
    return change.after === null
      ? `${subject} set back to the preset for everyone`
      : `${subject} set to ${valueWord(change.after, change.key)} for everyone`;
  }
  return change.after === null
    ? `${change.target.agentName}: ${subject} back to the default`
    : `${change.target.agentName}: ${subject} ${valueWord(change.after, change.key)}`;
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
  /** The `permission.changed` event this write undid. */
  undoOf?: string;
  /** What made the change, when it was not a write anyone asked for. */
  origin?: PermissionChangedMetadata['origin'];
  /** A sentence the history shows beside the change, when it alone would mislead. */
  note?: string;
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
    ...(record.undoOf ? { undoOf: record.undoOf } : {}),
    ...(record.origin ? { origin: record.origin } : {}),
    ...(record.presetSnapshot ? { presetSnapshot: record.presetSnapshot } : {}),
    ...(record.note ? { note: record.note } : {}),
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
    summary:
      record.surface === 'undo' && record.undoOf
        ? `Undo: ${describePermissionChanges(record.changes, record.actionTitle)}`
        : describePermissionChanges(record.changes, record.actionTitle),
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

/** One history line before its `undone` is known. */
type HistoryLine = Omit<PermissionHistoryEntry, 'undone'>;

/**
 * One Activity row as a history line, or `undefined` for a row the history
 * does not show (or one not about `agentId`, when given).
 *
 * @param row - The Activity row.
 * @param agentId - Narrow to lines about one agent.
 */
function toHistoryLine(row: ActivityItem, agentId: string | undefined): HistoryLine | undefined {
  const base = {
    id: row.id,
    occurredAt: row.occurredAt,
    actorLabel: row.actorLabel,
    summary: row.summary,
  };
  const ownRow = !agentId || row.resourceId === agentId;
  switch (row.eventType) {
    case PERMISSION_CHECK_UNAVAILABLE_EVENT:
      if (!ownRow) return undefined;
      // A notice, not a change: no rows, and the outside-check's own labels.
      return {
        ...base,
        actorDetail: UNCHECKABLE_ACTOR_DETAIL,
        metadata: { changes: [], surface: 'file-edit', attribution: 'outside' },
        undoable: false,
      };
    case STANDING_GRANT_ENDED_EVENT:
      // An upgrade line, not a change to a setting: a standing permission had
      // no area and no state, so it carries no `changes` rows.
      if (!ownRow) return undefined;
      return {
        ...base,
        actorDetail: null,
        metadata: { changes: [], surface: 'upgrade', attribution: 'upgrade' },
        undoable: false,
      };
    case PERMISSION_ANSWERED_EVENT: {
      // An answer on a request card. Its own `permission.changed` row (for an
      // Always allow) sits beside it; this one records the answer itself, and
      // has no Undo: the answer already happened.
      const answered = PermissionAnsweredMetadataSchema.safeParse(row.metadata);
      if (!answered.success || !ownRow) return undefined;
      const attribution = postureAttribution(answered.data.posture);
      return {
        ...base,
        actorDetail: actorDetailFor(attribution),
        metadata: {
          changes: [],
          surface: 'request-card',
          attribution,
          approvalId: answered.data.approvalId,
        },
        undoable: false,
      };
    }
    case PERMISSION_SUGGESTION_DISMISSED_EVENT:
    case PERMISSION_SUGGESTION_RESTORED_EVENT: {
      // "Not now" on the Always allow suggestion, and its Undo. The first is
      // undoable, so the suggestion can come back; the second is not, because
      // "Not now" on the next card says the same thing again.
      const restored = row.eventType === PERMISSION_SUGGESTION_RESTORED_EVENT;
      const meta = (
        restored
          ? PermissionSuggestionRestoredMetadataSchema
          : PermissionSuggestionDismissedMetadataSchema
      ).safeParse(row.metadata);
      if (!meta.success || !ownRow) return undefined;
      const attribution: PermissionAttribution =
        row.actorLabel === LOCAL_TRUST_ACTOR_LABEL ? 'local-trust' : 'signed-in';
      return {
        ...base,
        actorDetail: actorDetailFor(attribution),
        metadata: {
          changes: [],
          surface: restored ? 'undo' : 'request-card',
          attribution,
          approvalId: meta.data.approvalId,
          ...(restored ? { undoOf: undoOfRow(row) } : {}),
        },
        undoable: !restored,
      };
    }
    case PERMISSION_CHANGED_EVENT: {
      const parsed = PermissionChangedMetadataSchema.safeParse(row.metadata);
      if (!parsed.success) return undefined;
      if (agentId && !touchesAgent(row.resourceId, parsed.data, agentId)) return undefined;
      return {
        ...base,
        actorDetail: actorDetailFor(parsed.data.attribution),
        metadata: parsed.data,
        // An arrival screen's line has no Undo (see `isArrivalScreenLine`).
        undoable: parsed.data.changes.length > 0 && !isArrivalScreenLine(parsed.data),
      };
    }
    default:
      return undefined;
  }
}

/** How a card answer's posture reads as an attribution. */
function postureAttribution(posture: 'signed-in-operator' | 'local-trust'): PermissionAttribution {
  return posture === 'signed-in-operator' ? 'signed-in' : 'local-trust';
}

/** The event an Undo line undid, read off its metadata. */
function undoOfRow(row: ActivityItem): string | undefined {
  const undoOf = (row.metadata as { undoOf?: unknown } | null)?.undoOf;
  return typeof undoOf === 'string' ? undoOf : undefined;
}

/**
 * Which of these lines are undone now. A line is undone when an Undo of it
 * exists that is not itself undone, so an Undo of an Undo puts the first line
 * back in effect. An Undo is always newer than the line it undid, so reading
 * every line newer than the oldest one shown finds every Undo that matters,
 * across the whole history rather than one page of it.
 *
 * @param activity - The Activity reader.
 * @param lines - The lines shown, newest first.
 */
async function undoneLines(
  activity: Pick<ActivityService, 'list'>,
  lines: readonly HistoryLine[]
): Promise<Set<string>> {
  const oldest = lines.at(-1);
  if (!oldest) return new Set();
  const undosOf = new Map<string, string[]>();
  let cursor: string | undefined;
  for (;;) {
    const page = await activity.list({
      limit: SCAN_PAGE,
      categories: 'permissions',
      since: oldest.occurredAt,
      ...(cursor ? { before: cursor } : {}),
    });
    for (const row of page.items) {
      cursor = row.occurredAt;
      const undid = undoOfRow(row);
      if (undid) undosOf.set(undid, [...(undosOf.get(undid) ?? []), row.id]);
    }
    if (page.nextCursor === null) break;
  }
  const memo = new Map<string, boolean>();
  const isUndone = (id: string): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    memo.set(id, false);
    const undone = (undosOf.get(id) ?? []).some((undo) => !isUndone(undo));
    memo.set(id, undone);
    return undone;
  };
  return new Set(lines.filter((line) => isUndone(line.id)).map((line) => line.id));
}

/**
 * Read the permission history, newest first.
 *
 * With `agentId`, returns the events about that agent: single-agent events by
 * their `resourceId`, and default or bulk events whose `changes` touched it. The
 * category is low volume, so the filter runs over pages of the category rather
 * than a JSON query. Each line says whether it has an Undo and whether it is
 * undone now.
 *
 * @param activity - The Activity reader.
 * @param query - Optional agent, cursor and page size.
 */
export async function listPermissionHistory(
  activity: Pick<ActivityService, 'list'>,
  query: { agentId?: string; before?: string; limit: number }
): Promise<PermissionHistoryResponse> {
  const lines: HistoryLine[] = [];
  let cursor = query.before;
  let exhausted = false;
  while (lines.length < query.limit && !exhausted) {
    const page = await activity.list({
      limit: SCAN_PAGE,
      categories: 'permissions',
      ...(cursor ? { before: cursor } : {}),
    });
    for (const row of page.items) {
      cursor = row.occurredAt;
      const line = toHistoryLine(row, query.agentId);
      if (!line) continue;
      lines.push(line);
      if (lines.length === query.limit) break;
    }
    exhausted = page.nextCursor === null;
  }
  const undone = await undoneLines(activity, lines);
  const items = lines.map((line) => ({ ...line, undone: undone.has(line.id) }));
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

/**
 * The key a recorded change is about, as one string: `default:preset`,
 * `default:area:rooms`, `default:action:rooms.create`, `default:files`,
 * `default:files:codex`, `agent:<id>:area:rooms`, `agent:<id>:action:<id>`,
 * `agent:<id>:files`.
 *
 * @param change - The recorded change.
 */
function permissionKeyOf(change: PermissionChange): string {
  const layer = change.target.kind === 'agent' ? `agent:${change.target.agentId}` : 'default';
  switch (change.key.kind) {
    case 'preset':
      return `${layer}:preset`;
    case 'area':
      return `${layer}:area:${change.key.area}`;
    case 'action':
      return `${layer}:action:${change.key.action}`;
    case 'files':
      return change.key.runtime ? `${layer}:files:${change.key.runtime}` : `${layer}:files`;
  }
}

/** How many recent permission events the "why?" lines look through. */
export const LAST_CHANGE_DEPTH = 200;

/**
 * The most recent change to every setting in the recent history, keyed by
 * {@link permissionKeyOf}: what every "why?" line names as its last change.
 *
 * One read of the history per page, never one per row. A setting whose last
 * change is older than {@link LAST_CHANGE_DEPTH} events has no entry, and its
 * "why?" line names only where the state comes from.
 *
 * @param activity - The Activity reader, absent in a process with none.
 */
export async function readLastChanges(
  activity: Pick<ActivityService, 'list'> | undefined
): Promise<Map<string, PermissionLastChange>> {
  const found = new Map<string, PermissionLastChange>();
  if (!activity) return found;
  const history = await listPermissionHistory(activity, { limit: LAST_CHANGE_DEPTH });
  for (const entry of history.items) {
    for (const change of entry.metadata.changes) {
      const key = permissionKeyOf(change);
      if (found.has(key)) continue;
      found.set(key, {
        eventId: entry.id,
        occurredAt: entry.occurredAt,
        actorLabel: entry.actorLabel,
        attribution: entry.metadata.attribution,
        surface: entry.metadata.surface,
      });
    }
  }
  return found;
}

/** The last changes by {@link permissionKeyOf}, as `readLastChanges` returns them. */
export type LastChanges = ReadonlyMap<string, PermissionLastChange>;

/**
 * The newest of the recorded changes under any of `keys`, or `undefined`.
 *
 * @param index - The last change per key.
 * @param keys - Every key whose change could have decided the state.
 */
export function newestOf(
  index: LastChanges,
  keys: readonly string[]
): PermissionLastChange | undefined {
  let best: PermissionLastChange | undefined;
  for (const key of keys) {
    const found = index.get(key);
    if (found && (!best || found.occurredAt > best.occurredAt)) best = found;
  }
  return best;
}

/**
 * The resolver's keys for one state, most specific first. Paired with the
 * source each one decides as, so {@link lastChangeFor} can stop at the key that
 * decided.
 */
function resolverKeys(entry: {
  area: PermissionAreaId;
  actionId?: string;
  agentId?: string;
}): Array<{ key: string; source: PermissionSource }> {
  const keys: Array<{ key: string; source: PermissionSource }> = [];
  if (entry.agentId) {
    if (entry.actionId) {
      keys.push({ key: `agent:${entry.agentId}:action:${entry.actionId}`, source: 'agent-action' });
    }
    keys.push({ key: `agent:${entry.agentId}:area:${entry.area}`, source: 'agent-area' });
  }
  if (entry.actionId) {
    keys.push({ key: `default:action:${entry.actionId}`, source: 'default-action' });
  }
  keys.push({ key: `default:area:${entry.area}`, source: 'default-area' });
  keys.push({ key: 'default:preset', source: 'preset' });
  return keys;
}

/**
 * The last change behind one resolved state: the newest recorded change to the
 * key that decided it, or to a MORE specific key. A more specific key that is
 * no longer set was put back, which is exactly the change that made the state
 * fall through to where it comes from now, so it may be named. A LESS specific
 * key never is: a later change to the default does not touch an agent's own
 * setting, and naming it would credit the state to the wrong change.
 *
 * `unchanged` decides at the same place `preset` does (no preset chosen yet).
 * `floor` and `always-asks` clamp a stored Allowed and hide which layer said
 * it, so every key is a candidate.
 *
 * @param index - The last change per key.
 * @param entry - The area, the action (absent for the area as a whole), the
 *   agent (absent at the default layer), and where the state came from.
 */
export function lastChangeFor(
  index: LastChanges,
  entry: { area: PermissionAreaId; actionId?: string; agentId?: string; source: PermissionSource }
): PermissionLastChange | undefined {
  if (entry.source === 'inactive') return undefined;
  const keys = resolverKeys(entry);
  const decider = entry.source === 'unchanged' ? 'preset' : entry.source;
  const stop = keys.findIndex((k) => k.source === decider);
  const hidden = entry.source === 'floor' || entry.source === 'always-asks';
  const candidates = hidden || stop === -1 ? keys : keys.slice(0, stop + 1);
  return newestOf(
    index,
    candidates.map((k) => k.key)
  );
}

/** Add `lastChange` to an object when there is one. */
export function withLastChange<T extends object>(
  value: T,
  lastChange: PermissionLastChange | undefined
): T & { lastChange?: PermissionLastChange } {
  return lastChange ? { ...value, lastChange } : value;
}
