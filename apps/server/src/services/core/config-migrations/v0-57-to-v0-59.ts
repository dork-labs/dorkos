/**
 * The room helper still called by 0.60.0, plus the sidebar tolerance keys.
 * The 0.57.0 and 0.59.0 migrations are retired under the 0.115 upgrade floor.
 * @module services/core/config-migrations/v0-57-to-v0-59
 */
/**
 * Migration body: backfill the `rooms` section (the cascade ceiling agents
 * reply within, DOR-526) for configs persisted before it existed. Additive +
 * idempotent: only writes when the key is absent; the schema default also
 * yields this object on read, so this just writes it through on the upgrade
 * where it lands.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillRoomsDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const seeded = {
    maxAgentDepth: 3,
    maxAutomaticTurnsPerRoomPerHour: 60,
    maxAutomaticTurnsTotalPerHour: 240,
    replyWaitMinutes: 10,
    lateReplyCeilingMinutes: 60,
    engagedWindowMinutes: 10,
    engagedWindowPosts: 5,
    collectDebounceMs: 500,
    collectMaxEntries: 20,
  };
  const rooms = store.get('rooms');
  if (rooms == null) {
    store.set('rooms', seeded);
    return;
  }
  // conf merges top-level defaults SHALLOWLY, so a `rooms` block already on disk
  // never inherits a new nested field on its own. Supplying them here is what
  // stops an upgrade landing with no spend cap at all.
  const current = { ...(rooms as Record<string, unknown>) };
  let changed = false;
  for (const [key, value] of Object.entries(seeded)) {
    if (current[key] === undefined) {
      current[key] = value;
      changed = true;
    }
  }
  // `maxAutomaticTurnsPerHour` only ever existed on unreleased builds of this
  // feature; it was split into the per-room and total caps before shipping.
  // Carry its value onto the per-room cap rather than silently resetting a
  // number somebody chose, then drop it so the schema stops rejecting it.
  if (current.maxAutomaticTurnsPerHour !== undefined) {
    if (typeof current.maxAutomaticTurnsPerHour === 'number') {
      current.maxAutomaticTurnsPerRoomPerHour = current.maxAutomaticTurnsPerHour;
    }
    delete current.maxAutomaticTurnsPerHour;
    changed = true;
  }
  if (changed) store.set('rooms', current);
}

/**
 * Retired sidebar collapse flags still accepted by the runtime Ajv tolerance.
 */
const RETIRED_SIDEBAR_COLLAPSE_KEYS = {
  ungroupedCollapsed: 'agents',
  channelsCollapsed: 'channels',
  dmsCollapsed: 'dms',
  threadsCollapsed: 'threads',
  recentsCollapsed: 'recents',
} as const;

// The runtime tolerance remains until its separate compatibility cleanup.
export { RETIRED_SIDEBAR_COLLAPSE_KEYS };
