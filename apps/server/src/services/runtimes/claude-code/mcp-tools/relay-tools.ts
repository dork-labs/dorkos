/**
 * The relay tools an agent still has: listing endpoints and telling the user
 * something on a bound channel.
 *
 * Agent-to-agent messaging no longer rides Relay. The send, inbox and
 * endpoint-registration tools were retired for `chat_send`, `chat_read` and
 * `chat_stop` (spec `spin-off-chats` §7, ADR 261009-171114), which put every
 * message between agents in a chat a person can open.
 *
 * @module services/runtimes/claude-code/mcp-tools/relay-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';
import { inferEndpointType, requireRelay, type SenderIdentity } from './relay-helpers.js';
import { createRelayNotifyUserHandler } from './relay-notify-tools.js';

/** List all registered Relay endpoints. */
export function createRelayListEndpointsHandler(deps: McpToolDeps) {
  return async () => {
    const err = requireRelay(deps);
    if (err) return err;
    const relay = deps.relayCore!;
    const endpoints = relay.listEndpoints();
    const dispatchTtlMs = relay.getDispatchInboxTtlMs();
    const typed = endpoints.map((ep) => {
      const type = inferEndpointType(ep.subject);
      const expiresAt =
        type === 'dispatch'
          ? new Date(new Date(ep.registeredAt).getTime() + dispatchTtlMs).toISOString()
          : null;
      // `owner` is deliberately dropped. Agents need it for nothing, and naming
      // every mailbox's owner in one unrestricted call is the reconnaissance
      // step for impersonating one. The app's HTTP route still returns it.
      const { owner: _owner, ...rest } = ep;
      return { ...rest, type, expiresAt };
    });
    return jsonContent({ endpoints: typed, count: typed.length });
  };
}

/**
 * The relay tool definitions: name, description, input schema, and handler
 * (`relay_list_endpoints` and `relay_notify_user`).
 *
 * The single source for both on BOTH MCP servers. The external `/mcp` server
 * projects `relay_list_endpoints` through `registerFromDefinitions` rather than
 * typing it out again, which is what stops the two surfaces describing it
 * differently (DOR-499). `relay_notify_user` has no entry in the external
 * config, which is what keeps it in-session-only.
 *
 * @param deps - Tool dependencies
 * @param identity - Server-resolved sender identity, which `relay_notify_user`
 *   resolves the caller's own bindings from (never read from tool arguments).
 */
export function getRelayTools(deps: McpToolDeps, identity: SenderIdentity) {
  return [
    tool(
      'relay_list_endpoints',
      'List all registered Relay endpoints. Each endpoint includes subject, hash, maildirPath, ' +
        "registeredAt, type ('dispatch'|'query'|'persistent'|'agent'|'unknown'), and expiresAt " +
        '(ISO timestamp for dispatch endpoints indicating 30-min TTL expiry; null for others).',
      {},
      createRelayListEndpointsHandler(deps)
    ),
    tool(
      'relay_notify_user',
      'Send a message to the user on a bound external channel (Telegram, Slack, etc.). ' +
        'Automatically resolves the best active chat. If channel is omitted, sends to the ' +
        'most recently active chat across all bound adapters, and — when no external chat ' +
        'is connected at all — to your direct message with the user inside DorkOS. The ' +
        'reply says which one it used as "surface": "integration" or "dorkos-dm". Specify ' +
        'channel to target a specific adapter type (e.g., "telegram") or adapter ID (e.g., ' +
        '"telegram-lifeos"); naming one means that channel or nothing, never the DorkOS ' +
        'direct message. This always INITIATES a message — replying to an inbound chat ' +
        'message happens automatically and does not need this tool. Fails with code ' +
        'INITIATE_NOT_ALLOWED when the resolved binding has "Agent can start conversations" ' +
        'turned off. You have a limited number of these per hour, so send one when something ' +
        'actually needs the person — anything you could say in the conversation you are ' +
        'already in belongs there instead. The chat you are bound to may be a GROUP or a ' +
        'conversation with someone other than your operator: write the message to be read by ' +
        'whoever is in that chat, never as a private aside.',
      {
        message: z.string().describe('Message text to send to the user'),
        channel: z
          .string()
          .optional()
          .describe(
            'Optional adapter type or ID to target (e.g., "telegram", "telegram-lifeos"). Omit for most recent.'
          ),
      },
      createRelayNotifyUserHandler(deps, identity)
    ),
  ];
}
