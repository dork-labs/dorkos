/**
 * Which senders may shape the turn their message starts.
 *
 * @module relay/adapters/claude-code/turn-shaping-sender
 */

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
