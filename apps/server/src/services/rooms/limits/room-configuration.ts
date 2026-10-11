import {
  USER_CONFIG_DEFAULTS,
  sameSidebarItem,
  type UserConfig,
} from '@dorkos/shared/config-schema';
import { configManager } from '../../core/config-manager.js';
import type { EngagedWindow } from '../engagement.js';
import type { CollectWindow } from '../room-collect.js';
import type { ResponseGateMode } from '../response-gate/routing-rules.js';
import type { RoomStore } from '../room-store.js';
import { resolveRoomLimits, type RoomLimitsResolver } from './room-limits.js';

/**
 * The install-wide `rooms` settings, or `null` when they cannot be read.
 *
 * `null` rather than a throw, because `RoomService.post` resolves limits on
 * EVERY write: a config manager that is not up yet — or a config file that
 * cannot be read — must never be able to stop a room accepting messages.
 * {@link resolveRoomLimits} lands a `null` on the schema's own defaults, so the
 * failure mode is "the limits used their defaults", never "the limits were
 * absent", which is the only direction it is safe to fail in.
 */
export function readRoomsConfig() {
  try {
    return configManager.get('rooms');
  } catch {
    return null;
  }
}

/**
 * The ladder, bound to this install's rooms table.
 *
 * One indexed primary-key read per resolution, and it is resolved per dispatch
 * rather than captured — so an override set on a room, or a number changed in
 * Settings, binds the very next message rather than the next server start. A
 * room that has vanished resolves to the install's own limits.
 *
 * @param store - The rooms table, for the first rung.
 */
export function createRoomLimitsResolver(store: RoomStore): RoomLimitsResolver {
  return (roomId) => resolveRoomLimits(store.getRoom(roomId), readRoomsConfig());
}

/**
 * A room-turn bound in milliseconds, read live from config and degrading to the
 * shipped default the same way {@link readMaxAgentDepth} does — a config
 * manager that is not up yet must never stop a room answering.
 *
 * @param field - Which `rooms.*` minutes field to read.
 */
export function readRoomMinutesMs(field: 'replyWaitMinutes' | 'lateReplyCeilingMinutes'): number {
  try {
    return configManager.get('rooms')[field] * 60_000;
  } catch {
    return USER_CONFIG_DEFAULTS.rooms[field] * 60_000;
  }
}

/**
 * This install's extension → viewer overrides, or `undefined` when it has none.
 *
 * Read through the same tolerant path the room limits use: a config store that
 * cannot be read must not stop somebody opening a file, so an unreadable config
 * means the built-in viewer table, which is what every install without an
 * override already gets.
 */
export function readViewerOverrides(): Record<string, string> | undefined {
  try {
    return configManager.get('workbench')?.defaultViewers;
  } catch {
    return undefined;
  }
}

/**
 * The live engaged-window ceilings, degrading to the shipped defaults the same
 * way {@link readMaxAgentDepth} does.
 *
 * Failing to the defaults keeps the window BOUNDED, which is the only direction
 * it is safe to fail in: an unreadable config must never be able to leave an
 * agent engaged forever.
 */
export function readEngagedWindow(): EngagedWindow {
  try {
    const rooms = configManager.get('rooms');
    return { minutes: rooms.engagedWindowMinutes, posts: rooms.engagedWindowPosts };
  } catch {
    return {
      minutes: USER_CONFIG_DEFAULTS.rooms.engagedWindowMinutes,
      posts: USER_CONFIG_DEFAULTS.rooms.engagedWindowPosts,
    };
  }
}

/**
 * The live collect ceilings, degrading to the shipped defaults the same way
 * {@link readEngagedWindow} does — and failing in the same direction, which for
 * this pair means failing to the values that gather MORE into one turn. An
 * unreadable config must never be able to buy a turn per message.
 */
export function readCollectWindow(): CollectWindow {
  try {
    const rooms = configManager.get('rooms');
    return { debounceMs: rooms.collectDebounceMs, maxEntries: rooms.collectMaxEntries };
  } catch {
    return {
      debounceMs: USER_CONFIG_DEFAULTS.rooms.collectDebounceMs,
      maxEntries: USER_CONFIG_DEFAULTS.rooms.collectMaxEntries,
    };
  }
}

/**
 * Whether the response gate is on, degrading to the shipped default the same way
 * {@link readEngagedWindow} does.
 *
 * Failing to the DEFAULT rather than to `'off'` is deliberate, and it is the
 * same direction every other reader here fails in: the failure mode is "the
 * setting used its default", never "the setting was absent". An unreadable
 * config file must not quietly buy back a turn per overheard message — and it
 * cannot silence anything either, because the gate only ever excuses a message
 * that named somebody else.
 */
export function readResponseGate(): ResponseGateMode {
  try {
    return configManager.get('rooms').responseGate;
  } catch {
    return USER_CONFIG_DEFAULTS.rooms.responseGate;
  }
}

/**
 * How many files one message may carry, read live from `uploads.maxFiles` and
 * degrading to the shipped default the same way {@link readMaxAgentDepth} does.
 *
 * Failing to the default keeps the limit BOUNDED, which is the only safe
 * direction: an unreadable config must never let one message name every file in
 * the room.
 */
export function readMaxAttachmentsPerEntry(): number {
  try {
    return configManager.get('uploads').maxFiles;
  } catch {
    return USER_CONFIG_DEFAULTS.uploads.maxFiles;
  }
}

/**
 * How many times one agent may change a room's shared canvas inside one turn,
 * read live from `rooms.maxCanvasOpsPerTurn` and degrading to the shipped
 * default the same way {@link readMaxPostsPerTurn} does (spec `room-canvas`
 * §3.4).
 *
 * Failing to the default keeps the limit BOUNDED, which is the only safe
 * direction here too: an unreadable config must never let one turn bury a room's
 * table under tabs nobody asked for.
 */
export function readMaxCanvasOpsPerTurn(): number {
  try {
    return configManager.get('rooms').maxCanvasOpsPerTurn;
  } catch {
    return USER_CONFIG_DEFAULTS.rooms.maxCanvasOpsPerTurn;
  }
}

/**
 * How many conversations one agent may work in at once, read live from
 * `rooms.maxConcurrentTurnsPerAgent` (DOR-2104).
 *
 * Two different failures, and only one of them is handled here. A value in the
 * file that the schema refuses (`0`, `99`, `"x"`) never reaches this function:
 * the config manager repairs it to the shipped default, three, when it loads the
 * file. What this catch covers is a config that cannot be read at all, and that
 * answers ONE rather than three, because one is the direction that cannot hurt:
 * it may make an agent wait for its other turn to finish, but never lets more
 * turns loose in one folder than a person asked for (the contention ADR
 * `260726-170125` measured). `claimBusyWith` reads anything below one as one
 * too, so no path ends with an unbounded ceiling.
 */
export function readMaxConcurrentTurnsPerAgent(): number {
  try {
    return configManager.get('rooms').maxConcurrentTurnsPerAgent;
  } catch {
    return 1;
  }
}

/**
 * How many messages one agent may post into a room inside one turn, read live
 * from `rooms.maxPostsPerTurn` and degrading to the shipped default the same way
 * {@link readMaxAgentDepth} does (spec `tool-only-room-replies` §D9).
 *
 * Failing to the default keeps the limit BOUNDED, which is the only safe
 * direction here: an unreadable config must never let one turn serialise an
 * essay across the room.
 */
export function readMaxPostsPerTurn(): number {
  try {
    return configManager.get('rooms').maxPostsPerTurn;
  } catch {
    return USER_CONFIG_DEFAULTS.rooms.maxPostsPerTurn;
  }
}

/**
 * Whether the operator has muted one room, read live from `ui.sidebar.muted`
 * and degrading to "not muted" the same way {@link readMaxAgentDepth} degrades
 * to its own default (spec `notification-system` task T11).
 *
 * "Not muted" is the safe failure direction here, the mirror image of every
 * other reader in this file: those bound what an agent may DO, so an
 * unreadable config has to fail toward the tighter limit. This one only
 * decides whether a `dm.received` row reaches the operator, so failing toward
 * SILENCE would be the config manager quietly deciding a real message never
 * happened — the config-read equivalent of the one thing `NotificationService`
 * itself promises never to do.
 *
 * `sameSidebarItem` is the exact equality the sidebar mutes and unmutes a room
 * with (`packages/shared/src/config-schema.ts`) — reused rather than
 * reimplemented, so there is no second "is this the same room" rule to drift
 * from the one the mute switch itself uses.
 *
 * @param roomId - The room to check.
 */
export function readRoomMuted(roomId: string): boolean {
  try {
    const muted = configManager.get('ui').sidebar.muted;
    return muted.some((ref) => sameSidebarItem(ref, { kind: 'room', roomId }));
  } catch {
    return false;
  }
}

/**
 * The live `welcomeBack` block, degrading to the shipped defaults the same way
 * {@link readMaxAgentDepth} does — and for one extra reason of its own.
 *
 * A config manager that is not up yet must never decide, by accident, that this
 * install has the feature ON or OFF. Falling back to the schema's own defaults
 * keeps the answer the one a person would get if they had never touched the
 * setting, which is the only honest reading of an unreadable config here.
 */
export function readWelcomeBack(): UserConfig['welcomeBack'] {
  try {
    return configManager.get('welcomeBack') ?? USER_CONFIG_DEFAULTS.welcomeBack;
  } catch {
    return USER_CONFIG_DEFAULTS.welcomeBack;
  }
}
