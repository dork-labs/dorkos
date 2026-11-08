/**
 * The permission model's plain id lists, with no imports at all.
 *
 * A constants leaf on purpose, the way `harness-ids.ts` carries `HARNESS_IDS`:
 * `config-schema.ts` is aliased to SRC in every vitest project, so what it
 * imports must never drag a second copy of a zod schema module in beside the
 * dist one (see `__tests__/aliased-module-imports.test.ts`). Config builds its
 * permission section from these lists; `permission-schemas.ts` builds the
 * named schemas from the same lists.
 *
 * @module shared/permissions/permission-ids
 */

/** The three states an area or a single action can be in, strictest first. */
export const PERMISSION_STATES = ['blocked', 'ask', 'allowed'] as const;

/**
 * The twelve areas that take a state. `files` is separate: it takes a trust stop.
 *
 * `extensions` holds every tool a running extension adds (DOR-2685). It has no
 * static member: its actions join the live registry while their extension runs.
 *
 * `own_chat` holds one action, an agent asking for its own conversation to be
 * summarized (DOR-2732). It is an area rather than an action filed under a
 * neighbour because an area-level setting elsewhere — Other agents set to Ask
 * or Blocked — must not quietly decide it: only a setting for THIS area (per
 * agent, or for everyone) does.
 */
export const PERMISSION_AREA_IDS = [
  'rooms',
  'tasks',
  'agents',
  'messages',
  'connections',
  'packages',
  'extensions',
  'own_chat',
  'settings',
  'safety',
  'permissions',
  'reach',
] as const;

/**
 * Every preset id, most careful first. `trusted` is the default since ADR
 * `261006-225605` (agents are trusted by default); `balanced` and `full` stay
 * parseable for configs that chose them, and the picker shows Trusted and
 * Careful only.
 */
export const PERMISSION_PRESETS = ['careful', 'balanced', 'full', 'trusted'] as const;

/**
 * The presets a person picks from, in the order the picker shows them. A stored
 * Balanced or Full power still reads correctly; it is just not offered.
 */
export const CHOOSABLE_PERMISSION_PRESETS = ['trusted', 'careful'] as const;

/** A capability id (`domain.verb`) or a hand-registered tool name (no dot). */
export const PERMISSION_ACTION_ID_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)?$/;

/**
 * Action ids an earlier release used, and the id each one is now. A person's setting stored under
 * an old id (an agent manifest's `permissions.actions`, or the defaults in `config.json`) must keep
 * applying to the same action, so a rename can never let a Blocked action fall back to its area or
 * preset. `commitments.*` became `todo_promises.*` (DOR-3933).
 */
export const RENAMED_PERMISSION_ACTIONS: Readonly<Record<string, string>> = {
  'commitments.add': 'todo_promises.add',
  'commitments.update': 'todo_promises.update',
  'commitments.list': 'todo_promises.list',
};

/**
 * A per-action settings map with every renamed id moved to its current id, or `null` when the map
 * names no renamed id. A setting already stored under the current id wins over the old one.
 *
 * @param actions - The stored per-action settings, keyed by action id.
 */
export function renameRetiredActionIds<T>(
  actions: Readonly<Record<string, T>>
): Record<string, T> | null {
  if (!Object.keys(actions).some((id) => Object.hasOwn(RENAMED_PERMISSION_ACTIONS, id))) {
    return null;
  }
  const out: Record<string, T> = {};
  for (const [id, state] of Object.entries(actions)) {
    if (!Object.hasOwn(RENAMED_PERMISSION_ACTIONS, id)) out[id] = state;
  }
  for (const [id, state] of Object.entries(actions)) {
    const current = RENAMED_PERMISSION_ACTIONS[id];
    if (current !== undefined && !Object.hasOwn(out, current)) out[current] = state;
  }
  return out;
}
