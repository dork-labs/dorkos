/**
 * Which senders may shape the turn their message starts, and the power bounds
 * and marks the turn carries because of who sent it.
 *
 * @module relay/adapters/claude-code/turn-shaping-sender
 */
import type {
  MessageOpts,
  TurnPermissionBound,
  TurnPermissionCeiling,
} from '@dorkos/shared/agent-runtime';
import { UNPROVEN_TEAMMATE_ORIGIN } from '@dorkos/shared/permission-semantics';
import { CARRIED_TURN_LIMITS_FIELD, isSealedTurnLimits } from '../../lib/carried-turn-limits.js';

/**
 * The sender of a relay message from a caller DorkOS cannot name, sent over
 * HTTP (`POST /api/relay/messages`). One of the outside senders
 * ({@link OUTSIDE_SENDER_PREFIX}).
 */
export const HTTP_RELAY_SENDER = 'relay.external.http';

/**
 * The family every sender from outside DorkOS's own principals is under: an
 * HTTP caller, an external MCP client. A turn from one of them always carries
 * the outsider mark, whatever its payload holds.
 */
const OUTSIDE_SENDER_PREFIX = 'relay.external.';

/**
 * Senders whose payload may shape a turn — its folder, the agent it acts as and
 * its permission mode: a person reached through a binding (`relay.human.*`),
 * the server's own principals (`relay.system.*`) and chat bridges
 * (`relay.bridge.*`). Every other sender — an agent (`relay.agent.*`), a
 * session (`relay.session.*`), an external MCP or HTTP caller — is read for its
 * words only. The server sets `from` on every path into the bus: an agent's
 * from its own identity, and on the HTTP API (`POST /api/relay/messages`) a
 * `relay.human.*` sender only for the person's own turn, while any other
 * caller's message goes from its own address with these fields removed
 * (DOR-5151).
 *
 * @param from - The envelope's sender address.
 */
export function isTurnShapingSender(from: string): boolean {
  return (
    from.startsWith('relay.human.') ||
    from.startsWith('relay.system.') ||
    from.startsWith('relay.bridge.')
  );
}

/**
 * The payload fields that shape a turn, read only from a sender that may shape
 * it ({@link isTurnShapingSender}). A route that forwards a caller's payload for
 * any other sender removes them.
 */
export const TURN_SHAPING_PAYLOAD_FIELDS = [
  'cwd',
  'forAgent',
  '__bindingPermissions',
  '__untrustedWords',
] as const;

/** The limits a message carries onto its turn ({@link CARRIED_TURN_LIMITS_FIELD}). */
type CarriedTurnLimits = Pick<MessageOpts, 'permissionCeiling' | 'carriedMarks'>;

const ASKS = new Set(['always', 'when-risky', 'never']);
const REACH = new Set(['read', 'edit', 'workspace', 'everything']);

/**
 * One carried bound as written, or the runtime's default when it can't be read.
 * A teammate's chain counts a turn against a space's monthly limit by the rooms
 * it names, so those rooms are kept only from limits the server sealed. An
 * unsealed chain (a stamp from before a restart no longer verifies) names
 * {@link UNPROVEN_TEAMMATE_ORIGIN} instead: the turn still reads as a
 * teammate's, and is held to and counted against every space's limit.
 */
function readBound(value: unknown, sealed: boolean): TurnPermissionBound {
  if (value === 'runtime-default' || typeof value !== 'object' || value === null) {
    return 'runtime-default';
  }
  const level = value as Record<string, unknown>;
  const teammate = level.teammate;
  const teammateOk =
    teammate === undefined ||
    (Array.isArray(teammate) &&
      teammate.every((o) => typeof o?.roomId === 'string' && typeof o?.authorId === 'string'));
  if (!ASKS.has(level.asks as string) || !REACH.has(level.reach as string) || !teammateOk) {
    return 'runtime-default';
  }
  if (sealed || teammate === undefined) return value as TurnPermissionBound;
  return { ...level, teammate: [UNPROVEN_TEAMMATE_ORIGIN] } as unknown as TurnPermissionBound;
}

/**
 * The limits a payload carries onto its turn. Anything there that can't be
 * read holds the turn at the runtime's default and marks it, never looser.
 */
function carriedTurnLimitsOf(
  payload: Record<string, unknown> | null,
  from: string | undefined
): CarriedTurnLimits {
  const raw = payload?.[CARRIED_TURN_LIMITS_FIELD];
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null) {
    return { permissionCeiling: 'runtime-default', carriedMarks: { outsider: true } };
  }
  const { permissionCeiling, carriedMarks } = raw as Record<string, unknown>;
  const sealed = from !== undefined && isSealedTurnLimits(from, raw as Record<string, unknown>);
  const bounds = permissionCeiling === undefined ? [] : [permissionCeiling].flat();
  return {
    ...(bounds.length > 0
      ? { permissionCeiling: bounds.map((bound) => readBound(bound, sealed)) }
      : {}),
    ...(carriedMarks !== undefined ? { carriedMarks: { outsider: true } } : {}),
  };
}

/** A ceiling as the list of bounds that all hold. */
function boundsOf(ceiling: TurnPermissionCeiling | undefined): TurnPermissionBound[] {
  if (ceiling === undefined) return [];
  return Array.isArray(ceiling) ? [...ceiling] : [ceiling as TurnPermissionBound];
}

/**
 * The power bounds and marks a relay turn is sent with, decided by its sender.
 *
 * **The ceiling.** A binding's permission mode only reaches a conversation that
 * is NEW: a runtime resolves a turn as per-send → stored → its own default, and
 * a warm or stored conversation keeps the level it already has. So a sender
 * that may not shape the turn (another agent, the A2A gateway, an external MCP
 * or HTTP caller) also bounds THIS turn at the runtime's default, whatever the
 * conversation is set to. Power flows downstream, never up (spec
 * `trusted-by-default-flip` §4).
 *
 * **The mark (DOR-3858, behind its boot flag).** A person in a bound chat who
 * is not on the connection's approver allowlist, or anyone in a group chat, is
 * not proven to be the owner. Their turn carries the outsider mark, which makes
 * raises, standing grants, connector sends and destructive actions ask a
 * person. It is a mark, never a ceiling: the turn keeps its agent's set level
 * (DOR-3440), and a ceiling would lower it.
 *
 * **What the sender's own turns carry (DOR-5151).** A message sent over HTTP
 * by an agent whose running turns are marked or held carries those limits
 * ({@link CARRIED_TURN_LIMITS_FIELD}), exactly as a chat it starts over the
 * sessions API does, so the message's turn holds them too. They add to the
 * bounds above and never lift one. A teammate's chain among them counts the
 * turn against a space's monthly limit, so it is read only from limits the
 * server sealed for this sender ({@link isSealedTurnLimits}); anyone else's
 * copy keeps its bounds and its mark, and names no room of its own (DOR-5201).
 * A message from an outside sender ({@link OUTSIDE_SENDER_PREFIX}) always
 * carries the outsider mark.
 *
 * @param trustedShaper - Whether the sender may shape the turn ({@link isTurnShapingSender}).
 * @param markStrangers - Whether DOR-3858's flag is on, so a sender the host found unproven
 *   (`__untrustedWords` from a shaping sender) is marked.
 * @param payload - The message's payload, for whether the host found the sender unproven and
 *   the limits it carries.
 * @param from - The envelope's sender, which the server's seal on those limits names.
 */
export function turnPowerOptions(
  trustedShaper: boolean,
  markStrangers: boolean,
  payload: Record<string, unknown> | null = null,
  from?: string
): CarriedTurnLimits {
  const stranger = markStrangers && trustedShaper && payload?.__untrustedWords === true;
  const outside = from?.startsWith(OUTSIDE_SENDER_PREFIX) === true;
  const carried = carriedTurnLimitsOf(payload, from);
  const bounds: TurnPermissionBound[] = [
    ...(trustedShaper ? [] : ['runtime-default' as const]),
    ...boundsOf(carried.permissionCeiling),
  ];
  const marked = stranger || outside || carried.carriedMarks !== undefined;
  return {
    ...(bounds.length > 0 ? { permissionCeiling: bounds.length === 1 ? bounds[0]! : bounds } : {}),
    ...(marked ? { carriedMarks: { outsider: true as const } } : {}),
  };
}
