/**
 * Which senders may shape the turn their message starts, and the power bounds
 * and marks the turn carries because of who sent it.
 *
 * @module relay/adapters/claude-code/turn-shaping-sender
 */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';

/**
 * Senders whose payload may shape a turn — its folder, the agent it acts as and
 * its permission mode: a person reached through a binding (`relay.human.*`),
 * the server's own principals (`relay.system.*`) and chat bridges
 * (`relay.bridge.*`). Every other sender — an agent (`relay.agent.*`), a
 * session (`relay.session.*`), an external MCP caller — is read for its words
 * only. An agent's `from` is stamped by the server from its own identity, so
 * an agent cannot claim to be a person. A caller of the HTTP API
 * (`POST /api/relay/messages`) may name a `relay.human.*` sender and is then
 * trusted as the person, exactly as the rest of `/api` trusts its caller; only
 * the server's own principals are refused there.
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
 * The power bounds and marks a relay turn is sent with, decided by its sender.
 *
 * **The ceiling.** A binding's permission mode only reaches a conversation that
 * is NEW: a runtime resolves a turn as per-send → stored → its own default, and
 * a warm or stored conversation keeps the level it already has. So a sender
 * that may not shape the turn (another agent, the A2A gateway, an external MCP
 * client) also bounds THIS turn at the runtime's default, whatever the
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
 * @param trustedShaper - Whether the sender may shape the turn ({@link isTurnShapingSender}).
 * @param stranger - Whether the flag is on and the host found the sender unproven.
 */
export function turnPowerOptions(
  trustedShaper: boolean,
  stranger: boolean
): Pick<MessageOpts, 'permissionCeiling' | 'carriedMarks'> {
  return {
    ...(trustedShaper ? {} : { permissionCeiling: 'runtime-default' as const }),
    ...(stranger ? { carriedMarks: { outsider: true as const } } : {}),
  };
}
