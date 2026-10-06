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

/** The three presets a person picks from, most careful first. */
export const PERMISSION_PRESETS = ['careful', 'balanced', 'full'] as const;

/** A capability id (`domain.verb`) or a hand-registered tool name (no dot). */
export const PERMISSION_ACTION_ID_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)?$/;
