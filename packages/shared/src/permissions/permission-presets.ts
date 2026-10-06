/**
 * The preset tables, plus the hidden Unchanged table that stands in while no
 * preset has been chosen (spec `agent-permissions` D5).
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
  /** The Files & commands trust stop this preset writes; `null` leaves it alone. */
  readonly filesStop: PermissionStop | null;
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

/** The three shipped presets, frozen. */
export const PERMISSION_PRESET_TABLES: Readonly<Record<PermissionPreset, PermissionPresetTable>> =
  Object.freeze({ careful: CAREFUL, balanced: BALANCED, full: FULL });

/**
 * Unchanged: what an install gets while `permissions.preset` is `null`. It must
 * reproduce the behaviour before permissions existed EXACTLY: Rooms management
 * was an off-by-default tool group (Blocked), the floor areas were not reachable
 * by an agent (Blocked), and everything else ran on its tier alone (Allowed).
 *
 * `rooms.merge` has an action entry of its own: it was never behind the
 * `roomsManage` tool group, so it ran on every install. Putting it in the Rooms
 * area with the area's Blocked would silently remove it from undecided installs
 * (a decomposition-stage resolution of a spec gap).
 *
 * `operator.update_agent_boundaries` has one too, for the same reason: it sits
 * in Safety limits, which Unchanged blocks, but it always ran behind a card of
 * its own (it is `destructive`), so an undecided install keeps asking for it
 * rather than losing it.
 *
 * Extension tools (DOR-2685) did not exist before permissions, so there is no
 * old behaviour to reproduce; they take the same answer as every other
 * non-floor area here, Allowed, so their tier alone decides. A destructive
 * extension tool still asks: the resolver turns an area-level Allowed on a
 * destructive action into Ask.
 *
 * `filesStop: null`: the stored trust stop stays untouched.
 *
 * Own chat (DOR-2732) is a new area — an agent asking for its OWN conversation
 * to be summarized — so it has no old behaviour to reproduce, and it is Allowed
 * here and in all three presets. A permissive default, argued: it reaches
 * nothing outside the agent's own conversation, runs only after the asking turn
 * ends, at most once an hour, and the chat shows it happened. Adding an area
 * changes no shipped value.
 */
export const UNCHANGED_PERMISSION_TABLE: PermissionPresetTable = Object.freeze({
  areas: Object.freeze({
    rooms: 'blocked',
    tasks: 'allowed',
    agents: 'allowed',
    messages: 'allowed',
    connections: 'allowed',
    packages: 'allowed',
    extensions: 'allowed',
    own_chat: 'allowed',
    settings: 'allowed',
    safety: 'blocked',
    permissions: 'blocked',
    reach: 'blocked',
  }),
  actions: Object.freeze({
    'rooms.merge': 'allowed',
    'operator.update_agent_boundaries': 'ask',
  }),
  filesStop: null,
});

/**
 * The table a config resolves against: the chosen preset, or Unchanged when no
 * preset has been chosen.
 *
 * @param preset - The stored preset, or `null` for not chosen yet.
 */
export function presetTableFor(preset: PermissionPreset | null): PermissionPresetTable {
  return preset === null ? UNCHANGED_PERMISSION_TABLE : PERMISSION_PRESET_TABLES[preset];
}
