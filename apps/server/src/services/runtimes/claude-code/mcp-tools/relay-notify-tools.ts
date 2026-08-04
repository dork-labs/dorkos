/**
 * The `relay_notify_user` MCP tool handler.
 *
 * Split out of `relay-tools.ts`: every other Relay tool speaks to the message
 * bus, while this one reaches a person on an external chat channel and pulls in
 * the binding store, binding router, and adapter manager to do it.
 *
 * @module services/runtimes/claude-code/mcp-tools/relay-notify-tools
 */
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';
import { requireRelay, type SenderIdentity } from './relay-helpers.js';
import { resolveNotifyTarget } from '../../../relay/notify-target.js';
import { buildBridgePrincipal } from '../../../relay/bridge-principal.js';

/**
 * Send a message to a user on a bound external integration.
 *
 * @param deps - Tool dependencies
 * @param identity - Server-injected sender identity; its `agentId` selects the
 *   caller's own integration bindings (never taken from tool args)
 */
export function createRelayNotifyUserHandler(deps: McpToolDeps, identity: SenderIdentity) {
  return async (args: { message: string; channel?: string }) => {
    const err = requireRelay(deps);
    if (err) return err;
    if (!deps.bindingRouter || !deps.bindingStore) {
      return jsonContent(
        { error: 'Binding system not available', code: 'BINDINGS_DISABLED' },
        true
      );
    }

    const agentId = identity.agentId;
    if (!agentId) {
      return jsonContent(
        {
          error:
            'This session is not a registered agent, so it has no integration bindings to notify through.',
          code: 'NOT_AN_AGENT',
        },
        true
      );
    }

    // Resolve the integration via the shared resolver (also used by the system-level
    // TaskCompletionNotifier, DOR-240) so both proactive paths honor identical
    // binding, active-session, and `canInitiate` (DOR-239) rules.
    const target = resolveNotifyTarget(agentId, {
      bindingStore: deps.bindingStore,
      bindingRouter: deps.bindingRouter,
      adapterManager: deps.adapterManager,
      bridgeStore: deps.bridgeStore,
      channel: args.channel,
    });

    if (!target.ok) {
      switch (target.reason) {
        case 'NO_BINDING':
          return jsonContent(
            {
              sent: false,
              error: args.channel
                ? `No binding found for channel "${args.channel}"`
                : 'No adapter bindings found for this agent',
              availableChannels: target.availableChannels,
              code: 'NO_BINDING',
            },
            true
          );
        case 'NO_ACTIVE_SESSIONS':
          return jsonContent(
            {
              sent: false,
              error:
                'No active chat sessions found. The user must message the bot first to establish a chat.',
              availableAdapters: target.availableAdapters,
              code: 'NO_ACTIVE_SESSIONS',
            },
            true
          );
        case 'INITIATE_NOT_ALLOWED':
          // relay_notify_user always INITIATES a message — it is never how an
          // agent replies to an inbound chat message (replies to a
          // <relay_context> turn are forwarded automatically by the runtime
          // adapter, see context-builder.ts). So a false canInitiate on the
          // resolved binding unconditionally blocks this call; it never blocks
          // the automatic reply-forwarding path.
          return jsonContent(
            {
              sent: false,
              error:
                "This integration doesn't allow the agent to start conversations; reply routing still works.",
              code: 'INITIATE_NOT_ALLOWED',
              bindingId: target.bindingId,
              adapterId: target.adapterId,
            },
            true
          );
      }
    }

    try {
      // Same server-injected principal as every other send tool — the bare
      // agentId is not a relay subject and would not match any access rule.
      // A bridged target (§7.5) is the one exception: it publishes under the
      // bridge delivery principal instead, so a proactive notify still reads
      // as an INITIATE through the bridge consent branch rather than riding
      // this agent's own (already-checked) identity past it unlabeled.
      const from = target.bridged
        ? buildBridgePrincipal('initiate', target.adapterId, target.chatId)
        : identity.subject;
      const result = await deps.relayCore!.publish(target.subject, args.message, {
        from,
      });
      return jsonContent({
        sent: true,
        subject: target.subject,
        adapterId: target.adapterId,
        adapterType: target.adapterType,
        chatId: target.chatId,
        messageId: result.messageId,
        deliveredTo: result.deliveredTo,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Send failed';
      return jsonContent({ sent: false, error: message, code: 'SEND_FAILED' }, true);
    }
  };
}
