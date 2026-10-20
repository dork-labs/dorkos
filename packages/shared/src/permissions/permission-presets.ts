/**
 * The preset tables. An install that has not chosen one resolves against
 * Trusted (ADR `261006-225605`).
 *
 * **Shipped preset values are frozen.** Changing one later is a config migration
 * that first copies the old value into `permissions.defaults` for every install
 * on that preset, so no preset ever silently widens (`.claude/rules/safe-defaults.md`).
 * `__tests__/permission-presets.test.ts` pins every value literally.
 *
 * @module shared/permissions/permission-presets
 */
import type { PermissionStop } from '../agent-runtime.js';
import type { PermissionAreaId, PermissionPreset, PermissionState } from './permission-schemas.js';

/** One preset: a state for every area, and the trust stop it sets for files. */
export interface PermissionPresetTable {
  /** A state for each of the twelve state areas. */
  readonly areas: Readonly<Record<PermissionAreaId, PermissionState>>;
  /** Action-level entries that beat the area entry. */
  readonly actions: Readonly<Record<string, PermissionState>>;
  /** The Files & commands trust stop this preset writes. */
  readonly filesStop: PermissionStop;
}

/**
 * Careful: agents ask before changing anything, and cannot reach outward.
 * Shipped values are frozen; see the module doc before changing one.
 */
const CAREFUL: PermissionPresetTable = Object.freeze({
  areas: Object.freeze({
    rooms: 'ask',
    tasks: 'ask',
    agents: 'ask',
    messages: 'allowed',
    connections: 'ask',
    packages: 'ask',
    extensions: 'ask',
    own_chat: 'allowed',
    settings: 'ask',
    safety: 'ask',
    permissions: 'ask',
    reach: 'blocked',
  }),
  actions: Object.freeze({}),
  filesStop: 'ask',
});

/**
 * Balanced: agents run their rooms and ask for everything wider.
 * Shipped values are frozen; see the module doc before changing one.
 */
const BALANCED: PermissionPresetTable = Object.freeze({
  areas: Object.freeze({
    rooms: 'allowed',
    tasks: 'ask',
    agents: 'ask',
    messages: 'allowed',
    connections: 'ask',
    packages: 'ask',
    extensions: 'allowed',
    own_chat: 'allowed',
    settings: 'ask',
    safety: 'ask',
    permissions: 'ask',
    reach: 'ask',
  }),
  actions: Object.freeze({}),
  filesStop: 'act',
});

/**
 * Full power: agents do the everyday work themselves and ask before installing,
 * changing settings, or touching a floor area.
 * Shipped values are frozen; see the module doc before changing one.
 */
const FULL: PermissionPresetTable = Object.freeze({
  areas: Object.freeze({
    rooms: 'allowed',
    tasks: 'allowed',
    agents: 'allowed',
    messages: 'allowed',
    connections: 'allowed',
    packages: 'ask',
    extensions: 'allowed',
    own_chat: 'allowed',
    settings: 'ask',
    safety: 'ask',
    permissions: 'ask',
    reach: 'ask',
  }),
  actions: Object.freeze({}),
  filesStop: 'autonomy',
});

/**
 * Trusted: agents act with full power and every action is recorded (ADR
 * `261006-225605`). Every in-circle area is Allowed. Two areas still ask:
 * Safety limits, because its loop-guard settings stay a person's call until
 * DOR-2745 decides their replacement, and Reach & secrets, which is never
 * Allowed for an agent. Files & commands runs at Full autonomy.
 * Shipped values are frozen; see the module doc before changing one.
 */
const TRUSTED: PermissionPresetTable = Object.freeze({
  areas: Object.freeze({
    rooms: 'allowed',
    tasks: 'allowed',
    agents: 'allowed',
    messages: 'allowed',
    connections: 'allowed',
    packages: 'allowed',
    extensions: 'allowed',
    own_chat: 'allowed',
    settings: 'allowed',
    safety: 'ask',
    permissions: 'allowed',
    reach: 'ask',
  }),
  actions: Object.freeze({}),
  filesStop: 'autonomy',
});

/** The shipped presets, frozen. */
export const PERMISSION_PRESET_TABLES: Readonly<Record<PermissionPreset, PermissionPresetTable>> =
  Object.freeze({ careful: CAREFUL, balanced: BALANCED, full: FULL, trusted: TRUSTED });

/**
 * The table a config resolves against: the chosen preset, or Trusted when no
 * preset has been chosen. Agents are trusted by default (ADR `261006-225605`),
 * so an install that never picked runs the way Trusted reads.
 *
 * @param preset - The stored preset, or `null` for not chosen yet.
 */
export function presetTableFor(preset: PermissionPreset | null): PermissionPresetTable {
  return preset === null ? TRUSTED : PERMISSION_PRESET_TABLES[preset];
}
