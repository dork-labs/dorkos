/**
 * The room domain's typed refusals, and the one port it needs into the agent
 * registry.
 *
 * Split out of `room-service.ts` so the routes can map an error onto a status
 * code without importing the service, and so the roster half and the room half
 * can throw the same errors without one importing the other.
 *
 * @module server/services/rooms/room-errors
 */
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';

/** Machine-readable failures the routes map onto status codes. */
export type RoomErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ENTRY_NOT_FOUND'
  | 'MEMBER_NOT_FOUND'
  | 'AGENT_NOT_FOUND'
  | 'SLUG_TAKEN'
  | 'INVALID_SLUG'
  | 'NESTED_THREAD'
  | 'ROOM_ARCHIVED'
  | 'OPERATOR_ONLY';

/** A refusal from the room domain, carrying a code the routes can switch on. */
export class RoomError extends Error {
  constructor(
    readonly code: RoomErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

/**
 * What the room domain needs to know about an agent, without reaching into mesh
 * internals.
 *
 * It never sees an agent's manifest ULID — that is the point of
 * ADR 260726-170126, enforced here by the interface simply having no field for
 * one. Everything is keyed on the directory, which is what survives the
 * reconciler.
 */
export interface RoomAgentLookup {
  /**
   * Resolve an agent by its directory.
   *
   * @param agentPath - Absolute path to the agent's project directory.
   */
  byPath(agentPath: string): RoomAgent | null;
}

/** What the room domain knows about one agent. */
export interface RoomAgent {
  /** The agent's handle — what somebody types after an `@`. */
  name: string;
  /** The agent's rendered name. */
  displayName: string;
  /** The manifest default, which seeds a DM membership. */
  responseMode: ResponseMode;
  /** Emoji avatar, cached onto the author row for rendering. */
  emoji: string | null;
  /** Identity colour, cached onto the author row for rendering. */
  color: string | null;
}
