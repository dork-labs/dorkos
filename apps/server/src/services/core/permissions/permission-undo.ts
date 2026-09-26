/**
 * Undo from the permission history (spec `agent-permissions` D14): set every
 * key a recorded `permission.changed` event moved back to its value before, as
 * one new audited change. Called by `PermissionService.undo`, which lends it
 * its dependencies and write helpers; kept in its own module because the
 * rules below (units, conflicts, the floor, the consent door) are a whole of
 * their own.
 *
 * @module services/core/permissions/permission-undo
 */
import {
  PERMISSION_ANSWERED_EVENT,
  PERMISSION_AREA_IDS,
  PERMISSION_CHANGED_EVENT,
  PERMISSION_SUGGESTION_DISMISSED_EVENT,
  PERMISSION_SUGGESTION_RESTORED_EVENT,
  PermissionChangedMetadataSchema,
  PermissionSuggestionDismissedMetadataSchema,
  type PermissionSuggestionRestoredMetadata,
  isFloorArea,
  type AgentPermissions,
  type PermissionAreaId,
  type PermissionChange,
  type PermissionPreset,
  type PermissionState,
  type PermissionUndoSkip,
  type UndoPermissionChangeResponse,
} from '@dorkos/shared/permissions';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import type { ActivityItem } from '@dorkos/shared/activity-schemas';
import { PERMISSION_STOPS } from '@dorkos/shared/permission-semantics';

import type { PermissionChangeRecord, PermissionWriter } from './permission-history.js';
import type {
  PermissionActionInfo,
  PermissionAgentRef,
  PermissionServiceDeps,
} from './permission-service.js';
import {
  AUTONOMY_ACK_MESSAGE,
  PermissionError,
  compact,
  isArrivalScreenLine,
  isState,
  ownState,
} from './permission-values.js';

/** What the service lends an Undo. */
export interface UndoContext {
  /** The service's dependencies: config, agents, Activity. */
  deps: PermissionServiceDeps;
  /** Every action by id, for areas and titles. */
  actions: ReadonlyMap<string, PermissionActionInfo>;
  /** The target a change to one agent records. */
  agentTarget: (agent: PermissionAgentRef) => PermissionChange['target'];
  /** Record the Undo as one `permission.changed` event. */
  record: (record: Omit<PermissionChangeRecord, 'actionTitle'>) => Promise<void>;
}

/**
 * Undo one recorded permission change (spec `agent-permissions` D14): write
 * each key back to its recorded `before`, as ONE new `permission.changed`
 * event with `surface: 'undo'` and `undoOf`. An Undo is a change like any
 * other, audited and itself undoable.
 *
 * ## A key that moved on is a conflict, never silently overwritten
 *
 * For each recorded change, the key's value now is compared with the value
 * the change wrote (its `after`), the compare-and-set the request card's own
 * reversal uses. When it differs, setting it back would also undo whatever
 * changed it since:
 *
 * - a change to one target (the defaults, or one agent) is all or nothing:
 *   any conflict refuses the whole Undo with 409 `UNDO_CONFLICT`, listing
 *   each conflict, and writes nothing;
 * - a change that reached several targets (a default and the agents brought
 *   along with it) sets back every target that still matches and reports the
 *   rest as `skipped`; only when none still matches is it refused;
 * - `force` sets every key back regardless.
 *
 * A preset switch (an event with `presetSnapshot`) is one unit: its preset,
 * the default changes it cleared and its Files & commands stop go back
 * together or not at all. They go back from the recorded changes, which hold
 * exactly what the snapshot holds for every key the switch touched, so a
 * default changed since that the switch never touched is left as it is.
 *
 * ## What an Undo can never do
 *
 * - write Allowed in a locked area (Safety limits, Permissions, Reach &
 *   secrets): such a key is left alone and reported as `floor`, `force` or
 *   not. A change made outside DorkOS may have recorded such a value; putting
 *   it back would be a widening no door of DorkOS accepts;
 * - move Files & commands to Full autonomy without the acknowledgement on
 *   file (or sent with it): refused with 428 before anything is written, the
 *   same consent door every other write passes;
 * - run for anyone but a person: the route clears the person bars first, so
 *   an agent cannot use Undo to widen its own permissions, and a change an
 *   agent's settings file made outside DorkOS can only be undone by a person.
 *
 * An answer on a request card is not a change (409 `NOT_UNDOABLE`): it
 * already happened. An Always allow's own `permission.changed` row is.
 *
 * @param ctx - The service's dependencies and the helpers it lends.
 * @param eventId - The `permission.changed` event to undo.
 * @param input - `force` to set back keys that changed since, and the Full
 *   autonomy acknowledgement when the Undo needs it.
 * @param writer - Who is undoing it.
 * @returns What the Undo changed, and what it left alone.
 * @throws {PermissionError} `UNKNOWN_EVENT` (404), `NOT_UNDOABLE` (409),
 *   `UNDO_CONFLICT` (409, with `conflicts`), `AUTONOMY_ACK_REQUIRED` (428).
 */
export async function undoPermissionChange(
  ctx: UndoContext,
  eventId: string,
  input: { force?: boolean; acknowledgeAutonomy?: boolean },
  writer: PermissionWriter
): Promise<UndoPermissionChangeResponse> {
  const { deps, actions } = ctx;
  const event = deps.activity ? await deps.activity.get(eventId) : undefined;
  if (!event || event.category !== 'permissions') {
    throw new PermissionError(
      'UNKNOWN_EVENT',
      'That permission change is not in the history.',
      404
    );
  }
  if (event.eventType === PERMISSION_ANSWERED_EVENT) {
    throw new PermissionError(
      'NOT_UNDOABLE',
      'An answer on a request card already happened, so it can’t be undone. Change the setting instead.',
      409
    );
  }
  if (event.eventType === PERMISSION_SUGGESTION_DISMISSED_EVENT) {
    return undoSuggestionDismissal(deps, event, writer);
  }
  const parsed =
    event.eventType === PERMISSION_CHANGED_EVENT
      ? PermissionChangedMetadataSchema.safeParse(event.metadata)
      : undefined;
  if (!parsed?.success || parsed.data.changes.length === 0) {
    throw new PermissionError(
      'NOT_UNDOABLE',
      'This line in the history is not a change to undo.',
      409
    );
  }
  const metadata = parsed.data;
  if (isArrivalScreenLine(metadata)) {
    throw new PermissionError(
      'NOT_UNDOABLE',
      "DorkOS didn't apply these settings from the agent's own folder, so Undo can't put them back. Set any you want on the agent's page.",
      409
    );
  }
  const force = input.force === true;
  const acknowledge = input.acknowledgeAutonomy === true;

  const config = deps.config.get();
  const stops = deps.config.trustStops();
  const agents = new Map(deps.agents.list().map((a) => [a.id, a]));
  const storedByAgent = new Map<string, AgentPermissions>();
  for (const change of metadata.changes) {
    if (change.target.kind !== 'agent' || storedByAgent.has(change.target.agentId)) continue;
    const agent = agents.get(change.target.agentId);
    if (!agent) continue;
    storedByAgent.set(agent.id, (await deps.agents.readPermissions(agent.projectPath)) ?? {});
  }

  /** The value a recorded key holds now, or `gone` when its target no longer exists. */
  const currentOf = (change: PermissionChange): string | null | 'gone' => {
    if (change.target.kind === 'default') {
      switch (change.key.kind) {
        case 'preset':
          return config.preset;
        case 'area':
          return ownState(config.defaults.areas, change.key.area);
        case 'action':
          return ownState(config.defaults.actions, change.key.action);
        case 'files':
          if (!change.key.runtime) return stops.global;
          return Object.hasOwn(stops.perRuntime, change.key.runtime)
            ? (stops.perRuntime[change.key.runtime] ?? null)
            : 'gone';
      }
    }
    const stored = storedByAgent.get(change.target.agentId);
    if (!stored) return 'gone';
    switch (change.key.kind) {
      case 'area':
        return ownState(stored.areas, change.key.area);
      case 'action':
        return ownState(stored.actions, change.key.action);
      case 'files':
        return stored.filesAndCommands ?? null;
      case 'preset':
        return 'gone';
    }
  };

  /**
   * Setting this key back would make a locked area Allowed, or an action that
   * always shows what it would change Allowed. Neither may ever be written.
   */
  const widensFloor = (change: PermissionChange): boolean =>
    change.before === 'allowed' &&
    (change.key.kind === 'area' || change.key.kind === 'action') &&
    (isFloorArea(change.key.area) ||
      (change.key.kind === 'action' && actions.get(change.key.action)?.alwaysAsks === true));

  // Group the recorded changes into units that are set back together: a
  // preset switch's default half is one; every other change is its own.
  const snapshot = metadata.presetSnapshot;
  const units: PermissionChange[][] = [];
  const presetUnit: PermissionChange[] = [];
  for (const change of metadata.changes) {
    if (snapshot && change.target.kind === 'default') presetUnit.push(change);
    else units.push([change]);
  }
  if (presetUnit.length > 0) units.unshift(presetUnit);
  const targets = new Set(
    metadata.changes.map((c) => (c.target.kind === 'agent' ? c.target.agentId : 'default'))
  );
  const bulk = targets.size > 1;

  const skipped: PermissionUndoSkip[] = [];
  const conflicts: PermissionUndoSkip[] = [];
  const ready: PermissionChange[][] = [];
  for (const unit of units) {
    const usable: PermissionChange[] = [];
    let conflicted = false;
    for (const change of unit) {
      const current = currentOf(change);
      if (current === 'gone') {
        skipped.push({ change, current: null, reason: 'gone' });
        continue;
      }
      // Already back where the change found it (an earlier Undo of the same
      // change, or a later change that happened to put it back): nothing to
      // do, and nothing to ask about.
      if (current === change.before) continue;
      if (widensFloor(change)) {
        skipped.push({ change, current, reason: 'floor' });
        continue;
      }
      if (current !== change.after) {
        conflicts.push({ change, current, reason: 'changed-since' });
        conflicted = true;
      }
      usable.push(change);
    }
    if (conflicted && !force) continue;
    if (usable.length > 0) ready.push(usable);
  }
  if (conflicts.length > 0 && !force && (!bulk || ready.length === 0)) {
    throw new PermissionError('UNDO_CONFLICT', 'This has changed since. Set it back anyway?', 409, {
      conflicts,
    });
  }
  if (!force) skipped.push(...conflicts);

  // What the Undo writes, per target.
  const defaults = {
    areas: { ...config.defaults.areas },
    actions: { ...config.defaults.actions },
  };
  let preset = config.preset;
  let globalStop: PermissionStop | null | undefined;
  const runtimeStops = new Map<string, PermissionStop | null>();
  const agentNext = new Map<string, AgentPermissions>();
  const setKey = (
    record: Record<string, PermissionState>,
    key: string,
    value: string | null
  ): void => {
    if (value === null || !isState(value)) delete record[key];
    else record[key] = value;
  };
  for (const unit of ready) {
    for (const change of unit) {
      if (change.target.kind === 'default') {
        if (change.key.kind === 'preset') {
          preset = (change.before as PermissionPreset | null) ?? null;
        } else if (change.key.kind === 'area') {
          setKey(defaults.areas, change.key.area, change.before);
        } else if (change.key.kind === 'action') {
          setKey(defaults.actions, change.key.action, change.before);
        } else if (change.key.runtime) {
          runtimeStops.set(change.key.runtime, (change.before as PermissionStop | null) ?? null);
        } else {
          globalStop = (change.before as PermissionStop | null) ?? null;
        }
        continue;
      }
      const id = change.target.agentId;
      const next = agentNext.get(id) ?? structuredClone(storedByAgent.get(id) ?? {});
      next.areas = { ...(next.areas ?? {}) };
      next.actions = { ...(next.actions ?? {}) };
      if (change.key.kind === 'area') setKey(next.areas, change.key.area, change.before);
      else if (change.key.kind === 'action') setKey(next.actions, change.key.action, change.before);
      else if (change.key.kind === 'files') {
        const stop = change.before as PermissionStop | null;
        if (stop && PERMISSION_STOPS.includes(stop)) next.filesAndCommands = stop;
        else delete next.filesAndCommands;
      }
      agentNext.set(id, next);
    }
  }

  // The consent door, before anything is written.
  const toAutonomy =
    (globalStop === 'autonomy' && stops.global !== 'autonomy') ||
    [...runtimeStops].some(
      ([rt, stop]) => stop === 'autonomy' && stops.perRuntime[rt] !== 'autonomy'
    ) ||
    [...agentNext].some(
      ([id, next]) =>
        next.filesAndCommands === 'autonomy' &&
        storedByAgent.get(id)?.filesAndCommands !== 'autonomy'
    );
  if (toAutonomy && !acknowledge && !deps.config.hasAutonomyAck()) {
    throw new PermissionError('AUTONOMY_ACK_REQUIRED', AUTONOMY_ACK_MESSAGE, 428);
  }

  // The changes this Undo actually makes, current → restored.
  const changes: PermissionChange[] = [];
  const diffRecord = (
    target: PermissionChange['target'],
    before: Record<string, PermissionState> | undefined,
    after: Record<string, PermissionState> | undefined,
    key: (k: string) => PermissionChange['key'] | undefined
  ): void => {
    const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
    for (const k of keys) {
      const was = ownState(before, k);
      const now = ownState(after, k);
      const changeKey = key(k);
      if (was !== now && changeKey)
        changes.push({ target, key: changeKey, before: was, after: now });
    }
  };
  const actionArea = (id: string): PermissionAreaId | undefined => {
    const known = actions.get(id)?.area;
    if (known) return known;
    for (const c of metadata.changes) {
      if (c.key.kind === 'action' && c.key.action === id) return c.key.area;
    }
    return undefined;
  };
  const defaultTarget: PermissionChange['target'] = { kind: 'default' };
  if (preset !== config.preset) {
    changes.push({
      target: defaultTarget,
      key: { kind: 'preset' },
      before: config.preset,
      after: preset,
    });
  }
  diffRecord(defaultTarget, config.defaults.areas, defaults.areas, (k) =>
    (PERMISSION_AREA_IDS as readonly string[]).includes(k)
      ? { kind: 'area', area: k as PermissionAreaId }
      : undefined
  );
  diffRecord(defaultTarget, config.defaults.actions, defaults.actions, (k) => {
    const area = actionArea(k);
    return area ? { kind: 'action', action: k, area } : undefined;
  });
  if (globalStop !== undefined && globalStop !== stops.global) {
    changes.push({
      target: defaultTarget,
      key: { kind: 'files' },
      before: stops.global,
      after: globalStop,
    });
  }
  for (const [runtime, stop] of runtimeStops) {
    const was = stops.perRuntime[runtime] ?? null;
    if (was !== stop) {
      changes.push({
        target: defaultTarget,
        key: { kind: 'files', runtime },
        before: was,
        after: stop,
      });
    }
  }
  for (const [id, next] of agentNext) {
    const agent = agents.get(id)!;
    const was = storedByAgent.get(id) ?? {};
    const target = ctx.agentTarget(agent);
    diffRecord(target, was.areas, next.areas, (k) =>
      (PERMISSION_AREA_IDS as readonly string[]).includes(k)
        ? { kind: 'area', area: k as PermissionAreaId }
        : undefined
    );
    diffRecord(target, was.actions, next.actions, (k) => {
      const area = actionArea(k);
      return area ? { kind: 'action', action: k, area } : undefined;
    });
    if ((was.filesAndCommands ?? null) !== (next.filesAndCommands ?? null)) {
      changes.push({
        target,
        key: { kind: 'files' },
        before: was.filesAndCommands ?? null,
        after: next.filesAndCommands ?? null,
      });
    }
  }

  // Write: config, then stops, then each agent's manifest.
  const configMoved =
    preset !== config.preset ||
    changes.some(
      (c) => c.target.kind === 'default' && (c.key.kind === 'area' || c.key.kind === 'action')
    );
  if (configMoved) deps.config.set({ ...config, preset, defaults });
  // The acknowledgement lands before any stop, so no reader can catch Full
  // autonomy without the consent that licenses it.
  if (acknowledge && toAutonomy) deps.config.recordAutonomyAck();
  if (globalStop !== undefined && globalStop !== stops.global) {
    deps.config.setGlobalTrustStop(globalStop, false);
  }
  for (const [runtime, stop] of runtimeStops) {
    if ((stops.perRuntime[runtime] ?? null) !== stop)
      deps.config.setRuntimeTrustStop(runtime, stop);
  }
  for (const [id, next] of agentNext) {
    const was = storedByAgent.get(id) ?? {};
    if (JSON.stringify(compact(was) ?? null) === JSON.stringify(compact(next) ?? null)) continue;
    await deps.agents.writePermissions(id, compact(next));
  }

  await ctx.record({
    changes,
    surface: 'undo',
    writer,
    undoOf: eventId,
    // Putting a preset back is itself a preset switch, so the Undo of this
    // Undo moves the same keys back together.
    ...(changes.some((c) => c.key.kind === 'preset')
      ? {
          presetSnapshot: {
            preset: config.preset,
            defaults: config.defaults,
            trustStop: stops.global,
          },
        }
      : {}),
  });
  return { changes, skipped };
}

/**
 * Undo a "Not now" on the Always allow suggestion: record a
 * `permission.suggestion_restored` event, so the suggestion can come back for
 * that agent and action. The latest of the two events decides, so a "Not now"
 * given again later wins again. Nothing to do when the latest is already a
 * restore.
 *
 * @param deps - The service's dependencies.
 * @param event - The `permission.suggestion_dismissed` event.
 * @param writer - Who is undoing it.
 */
async function undoSuggestionDismissal(
  deps: PermissionServiceDeps,
  event: ActivityItem,
  writer: PermissionWriter
): Promise<UndoPermissionChangeResponse> {
  const parsed = PermissionSuggestionDismissedMetadataSchema.safeParse(event.metadata);
  if (!parsed.success || !deps.activity) {
    throw new PermissionError(
      'NOT_UNDOABLE',
      'This line in the history is not a change to undo.',
      409
    );
  }
  const { agentPath, action } = parsed.data;
  if (
    (await latestSuggestionEvent(deps.activity, agentPath, action)) !==
    PERMISSION_SUGGESTION_DISMISSED_EVENT
  ) {
    return { changes: [], skipped: [] };
  }
  const metadata: PermissionSuggestionRestoredMetadata = { ...parsed.data, undoOf: event.id };
  await deps.activity.emit({
    actorType: writer.actorType,
    actorLabel: writer.actorLabel,
    ...(writer.actorId ? { actorId: writer.actorId } : {}),
    category: 'permissions',
    eventType: PERMISSION_SUGGESTION_RESTORED_EVENT,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    resourceLabel: event.resourceLabel,
    summary: `Undo: ${event.summary}`,
    linkPath: null,
    metadata: metadata as unknown as Record<string, unknown>,
  });
  return { changes: [], skipped: [], suggestionRestored: true };
}

/**
 * The newest "Not now" or its Undo for one agent and action, by event type.
 *
 * @param activity - The Activity reader.
 * @param agentPath - The agent's project directory.
 * @param action - The capability id or tool name.
 */
async function latestSuggestionEvent(
  activity: Pick<NonNullable<PermissionServiceDeps['activity']>, 'list'>,
  agentPath: string,
  action: string
): Promise<string | undefined> {
  let cursor: string | undefined;
  for (;;) {
    const page = await activity.list({
      limit: 100,
      categories: 'permissions',
      ...(cursor ? { before: cursor } : {}),
    });
    for (const row of page.items) {
      cursor = row.occurredAt;
      if (
        row.eventType !== PERMISSION_SUGGESTION_DISMISSED_EVENT &&
        row.eventType !== PERMISSION_SUGGESTION_RESTORED_EVENT
      ) {
        continue;
      }
      const meta = row.metadata as { agentPath?: unknown; action?: unknown } | null;
      if (meta?.agentPath === agentPath && meta.action === action) return row.eventType;
    }
    if (page.nextCursor === null) return undefined;
  }
}
