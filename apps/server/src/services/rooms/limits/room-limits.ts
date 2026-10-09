/**
 * One ladder for every number that bounds automatic replies in one room
 * (DOR-1429).
 *
 * ## The ladder
 *
 * For each of the four settings, in order, first answer wins:
 *
 * 1. **The room's own column** — `rooms.turn_limits_enabled`,
 *    `max_agent_depth`, `max_turns_per_agent_per_cascade`,
 *    `max_auto_turns_per_hour`. `null` in every one of them means "no opinion",
 *    which is the state every room is created in.
 * 2. **User config** — the matching `rooms.*` field in `~/.dork/config.json`.
 * 3. **The schema default** — `USER_CONFIG_DEFAULTS.rooms`, for the case where
 *    config could not be read at all.
 *
 * Same shape as the launch-account ladder (ADR 260821-205323): a pure function
 * per decision, the rungs named in order, and no rung that can throw. Kept local
 * to this domain rather than shared, because nothing outside the rooms domain
 * has a reason to ask.
 *
 * ## The one asymmetry, stated plainly
 *
 * **A room opts out of its OWN bounds, never out of the install's wallet.**
 * When {@link ResolvedRoomLimits.turnLimitsEnabled} is false, this room runs
 * with no cascade guard and no per-room hourly ceiling — but
 * `rooms.maxAutomaticTurnsTotalPerHour`, the ceiling on what every room
 * together may cost in an hour, still gates it. Only the install-wide
 * `rooms.turnLimitsEnabled` takes that one off, and it is deliberately
 * unreachable from a room: the global cap has no per-room meaning and no
 * per-room column, so an unlimited room can spend the install's hour faster
 * than the others and still cannot spend more than the install has.
 *
 * That is why this function resolves four values and not five. `global()` on
 * {@link TurnBudgetLimits} is wired straight from config in
 * `services/rooms/index.ts`, where it reads the install-wide toggle and nothing
 * else — so the asymmetry is a shape in the code rather than a sentence in a
 * comment.
 *
 * @module server/services/rooms/limits/room-limits
 */
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { createRoomSpendPersistence, type Db } from '@dorkos/db';
import { configManager } from '../../core/config-manager.js';
import type { RoomDocStorage, RoomDocClaimData } from '@dorkos/db/internal-server';

/**
 * A room's stored overrides — the first rung.
 *
 * Structurally satisfied by `Room` (and by the raw table row), so callers pass
 * the room they already hold. Deliberately not `Room` itself: this module
 * decides four numbers and has no business depending on a roster, a slug or a
 * bridge.
 */
export interface RoomLimitOverrides {
  turnLimitsEnabled?: boolean | null;
  maxAgentDepth?: number | null;
  maxTurnsPerAgentPerCascade?: number | null;
  maxAutoTurnsPerHour?: number | null;
}

/**
 * The install-wide settings — the second rung.
 *
 * Every field optional, because the third rung exists for exactly the case
 * where the config manager could not answer.
 */
export interface RoomLimitConfig {
  turnLimitsEnabled?: boolean;
  maxAgentDepth?: number;
  maxTurnsPerAgentPerCascade?: number;
  maxAutomaticTurnsPerRoomPerHour?: number;
  maxAutomaticTurnsTotalPerHour?: number;
}

/** What one room's automatic replies are actually bounded by, right now. */
export interface ResolvedRoomLimits {
  /**
   * Whether THIS room's bounds apply at all.
   *
   * `false` means the cascade guard is not asked and the per-room hourly
   * ceiling is not counted here. The install-wide hourly total still is — see
   * the module doc.
   */
  turnLimitsEnabled: boolean;
  /**
   * How many automatic replies one chain in this room may run.
   *
   * **Resolved even when {@link ResolvedRoomLimits.turnLimitsEnabled} is
   * false**, because it is also the depth an un-provenanced agent post is
   * stamped at (`deriveCascade`). An unlimited room still writes a readable
   * chain, so turning limits back on judges what happened while they were off
   * exactly as it judges everything else.
   */
  maxAgentDepth: number;
  /** How many TURNS any ONE agent in this room may take. */
  maxTurnsPerAgentPerCascade: number;
  /** How many automatic replies this room may run in an hour. */
  maxAutoTurnsPerHour: number;
}

/**
 * Resolve what bounds one room, through the ladder above.
 *
 * Never throws and never reads anything: both rungs are handed in, so this is
 * as testable as the arithmetic it is. A caller with an unreadable config
 * passes `null` and lands on the shipped defaults, which is the only direction
 * it is safe to fail in — the failure mode is "the limits used their defaults",
 * never "the limits were absent".
 *
 * **That guarantee covers a missing rung, not a corrupt one.** A `turn_limits_enabled`
 * column holding something other than 0 or 1 — which only a hand-edited
 * database produces, since nothing in DorkOS writes one — is read by Drizzle's
 * boolean mode as `false`, and this function will faithfully report an
 * unlimited room. Left unclamped deliberately: a runtime clamp here would be a
 * guess about what a corrupt row meant, and somebody with write access to the
 * SQLite file can lift every ceiling more directly than by writing a `2`.
 *
 * @param room - The room's stored overrides, or `null` for a room that could
 *   not be read. Any `null`/absent field falls through to the next rung.
 * @param config - The install-wide `rooms` settings, or `null` when config is
 *   unavailable.
 * @returns The four numbers that bound this room right now.
 */
export function resolveRoomLimits(
  room: RoomLimitOverrides | null | undefined,
  config: RoomLimitConfig | null | undefined
): ResolvedRoomLimits {
  const defaults = USER_CONFIG_DEFAULTS.rooms;
  return {
    turnLimitsEnabled:
      room?.turnLimitsEnabled ?? config?.turnLimitsEnabled ?? defaults.turnLimitsEnabled,
    maxAgentDepth: room?.maxAgentDepth ?? config?.maxAgentDepth ?? defaults.maxAgentDepth,
    maxTurnsPerAgentPerCascade:
      room?.maxTurnsPerAgentPerCascade ??
      config?.maxTurnsPerAgentPerCascade ??
      defaults.maxTurnsPerAgentPerCascade,
    maxAutoTurnsPerHour:
      room?.maxAutoTurnsPerHour ??
      config?.maxAutomaticTurnsPerRoomPerHour ??
      defaults.maxAutomaticTurnsPerRoomPerHour,
  };
}

/**
 * What a room is bounded by, asked by id.
 *
 * The seam the rooms domain is given instead of four loose config readers: one
 * function, resolved per call so a change in Settings — or on the room — binds
 * the very next message rather than the next server start. A room that has
 * vanished resolves to the install's own limits, which is what every room
 * resolved to before this existed.
 */
export type RoomLimitsResolver = (roomId: string) => ResolvedRoomLimits;
/** Resolve the install-wide cap without consulting any per-room override. */
export function resolveGlobalRoomAutomaticTurnCap(
  config: RoomLimitConfig | null | undefined
): number | null {
  const defaults = USER_CONFIG_DEFAULTS.rooms;
  const enabled = config?.turnLimitsEnabled ?? defaults.turnLimitsEnabled;
  if (!enabled) return null;
  return config?.maxAutomaticTurnsTotalPerHour ?? defaults.maxAutomaticTurnsTotalPerHour;
}

/**
 * Outcome of asking for one automatic turn.
 *
 * Deliberately does NOT carry a headroom number. The obvious candidate — "turns
 * still available" — is zero at exactly the moment anything would want to read
 * it, because that is what a refusal means, so it would be a field that is
 * either uninteresting or constant. What a reader of the notice actually needs
 * is WHICH cap refused, since the two send them to different settings.
 */
export interface BudgetDecision {
  allowed: boolean;
  /** Set only when `allowed` is false: which cap said no. */
  scope?: 'room' | 'global';
  /**
   * Whether this turn was actually charged to a window.
   *
   * False when nothing was counting it — both caps off — in which case
   * `allowed` is true and no window moved. The one caller that needs the
   * difference is the notice log's re-arm: "the window rolled, so the next
   * exhaustion is news" is only true of a window that exists.
   */
  counted: boolean;
  /** Exceptional durable prepared-source refusal; memory is never refunded. */
  prepared?: true;
}

/**
 * The two live caps, read per call so a change in Settings — or on the room —
 * takes effect at once.
 *
 * **`null` is unlimited, and it is a distinct state rather than a big number**
 * (the plan's decision 4, `plans/room-turn-limits-overhaul.md`). A cap that is
 * off is not a cap of `Infinity`: nothing is reserved against it, nothing is
 * recorded for it, and {@link RoomTurnBudget.remaining} reports `null` so an
 * agent reading `room_context.budget` is told "no limit" instead of a number
 * nobody is counting down.
 *
 * The two are independent, because a room may be unlimited on an install that
 * is not (`resolveRoomLimits`, which owns that asymmetry). A room whose own cap
 * is `null` is still gated by `global()`.
 */
export interface TurnBudgetLimits {
  /**
   * Automatic turns this room may run per window, or `null` when this room's
   * own limits are off.
   *
   * Takes the room id because the ceiling is per room now: `rooms.max_auto_turns_per_hour`
   * overrides `rooms.maxAutomaticTurnsPerRoomPerHour` for one room (DOR-1429).
   */
  perRoom: (roomId: string) => number | null;
  /**
   * Automatic turns the whole install may run per window, across every room, or
   * `null` when the install-wide toggle is off.
   *
   * Takes no room id, and cannot: this is the install's wallet, and no room has
   * a say in it.
   */
  global: () => number | null;
}

/** Internal server module surface; no HTTP/MCP caller receives this companion. */
export interface RoomDocBudgetCompanion {
  begin(sourceHash: string, roomId: string): object;
  readGlobal(owner: object): void;
  readRoom(owner: object): void;
  readClock(owner: object): void;
  readDestinationPolicy(owner: object): Readonly<ResolvedRoomLimits>;
  prepare(
    owner: object,
    data: RoomDocClaimData
  ): ReturnType<RoomDocStorage['prepareAcceptedBarrier']>;
  commit(
    owner: object,
    data: RoomDocClaimData
  ): ReturnType<RoomDocStorage['commitPreparedRoomDoc']>;
  release(owner: object): ReturnType<RoomDocStorage['releaseKnownPreparedBarrier']>;
}

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

const originalBudgetPolicies = new WeakMap<
  TurnBudgetLimits,
  {
    db: Db;
    readRoom(roomId: string): Readonly<ResolvedRoomLimits>;
    readGlobal(): number | null;
  }
>();
/**
 * The two hourly ceilings, as the budget reads them — and the one place the
 * room/install asymmetry is spelled out in code.
 *
 * `perRoom` goes through the ladder, so a room may raise, lower or switch off
 * its own hourly ceiling. `global` does NOT and cannot: it reads the
 * install-wide toggle and the install-wide number, because
 * `rooms.maxAutomaticTurnsTotalPerHour` is the ceiling on what every room
 * together may cost and no room has a say in it. An unlimited ROOM is therefore
 * still charged against the install's hour — see `room-limits.ts`.
 *
 * `null` from either is "this cap is off", which the budget treats as a state
 * rather than a large number.
 *
 * @param limitsFor - The bound ladder.
 */
/** Fixed actual native/config construction; supplied ordinary resolvers never issue Doc policy. */
export function createTurnBudgetLimits(limitsFor: RoomLimitsResolver, db: Db): TurnBudgetLimits {
  const persistence = createRoomSpendPersistence(db);
  const readNative = persistence?.readRoomLimitData.bind(persistence);
  const readGlobal = () => resolveGlobalRoomAutomaticTurnCap(readRoomsConfig());
  const readRoom = (roomId: string) =>
    Object.freeze(resolveRoomLimits(readNative!(roomId), readRoomsConfig()));
  const limits: TurnBudgetLimits = {
    perRoom: (roomId) => {
      const resolved = readNative ? readRoom(roomId) : limitsFor(roomId);
      return resolved.turnLimitsEnabled ? resolved.maxAutoTurnsPerHour : null;
    },
    global: readGlobal,
  };
  if (readNative) originalBudgetPolicies.set(limits, { db, readRoom, readGlobal });
  return limits;
}
/** Recognizes only fixed factory membership and exact ownDb; no caller checker or registration. */
export function readOriginalRoomTurnBudgetPolicy(limits: TurnBudgetLimits, db: Db) {
  const original = originalBudgetPolicies.get(limits);
  return original?.db === db
    ? Object.freeze({ readRoom: original.readRoom, readGlobal: original.readGlobal })
    : undefined;
}
