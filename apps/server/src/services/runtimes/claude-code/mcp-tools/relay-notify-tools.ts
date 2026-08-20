/**
 * The `relay_notify_user` MCP tool handler.
 *
 * Every other Relay tool speaks to the message bus; this one reaches a person —
 * on an external chat channel when one is connected, and in DorkOS's own direct
 * messages when none is.
 *
 * **The delivery itself now rides the notification pipeline** (DOR-1383). The
 * verb is the `agent.note` notification kind, so a note also lands in the
 * operator's inbox as history rather than only passing through a chat window.
 * Nothing about the tool's surface, its scope or its bounds changed: the same
 * arguments, the same JSON answers, the same binding resolution, the same
 * `canInitiate` consent gate, the same hourly budget spent at the same moment.
 *
 * **An external integration is still first preference**, unchanged: if a bound
 * Telegram or Slack chat resolves, the message goes there under exactly the
 * rules it always did. The DM is what happens instead of nothing (DOR-1209).
 *
 * **What bounds it is an hourly count, not a card** (DOR-1265). This verb does
 * not raise an approval prompt for an agent-identified session — one raised
 * during a room turn parked the turn on a card nobody was watching — so
 * {@link NotifyBudget} is what stands between a looping agent and a person's
 * evening. Be precise about what that gave up and what it did not: the note goes
 * only inside a scope the OPERATOR configured — their own DorkOS DM, or a
 * binding they switched "Agent can start conversations" on for (`canInitiate`,
 * default false, so setup consent is untouched). That scope is frequently WIDER
 * than one person: a binding may name a group or somebody else's chat, and one
 * with the chat filter left empty (the cockpit's default) covers every chat that
 * has messaged the adapter. What the auto-allow removed is the per-call card an
 * operator watching a DIRECT session could have denied — not the scope, and not
 * the switch. A note the budget refuses now leaves no inbox row either, so the
 * ceiling bounds every surface rather than just the chat one.
 *
 * @module services/runtimes/claude-code/mcp-tools/relay-notify-tools
 */
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';
import { requireRelay, type SenderIdentity } from './relay-helpers.js';
import { logRefusal } from '../../../observability/refusals.js';
import { notify } from '../../../notifications/notification-service.js';
import {
  deliverOverRelay,
  type RelayDeliveryOutcome,
} from '../../../notifications/channels/relay.js';

/**
 * Turn the channel's outcome into the answer this tool has always given.
 *
 * The wording is deliberately preserved verbatim, refusal codes included: an
 * agent reading `NO_ACTIVE_SESSIONS` and being told to have the person message
 * the bot first is the difference between a retry that can work and one that
 * cannot.
 *
 * @param outcome - What the relay channel did, or `undefined` when it was never
 *   reached (the pipeline had nothing wired to send with).
 * @param channel - The channel the caller named, which changes two messages: a
 *   caller that named one never had a DM tried, so an error must not claim one
 *   failed and send them looking for a room nobody opened.
 */
function answerFor(outcome: RelayDeliveryOutcome | undefined, channel: string | undefined) {
  if (!outcome) {
    return jsonContent({ error: 'Binding system not available', code: 'BINDINGS_DISABLED' }, true);
  }
  if (outcome.ok) {
    if (outcome.surface === 'dorkos-dm') {
      return jsonContent({
        sent: true,
        surface: 'dorkos-dm',
        roomId: outcome.roomId,
        entryId: outcome.entryId,
      });
    }
    return jsonContent({
      sent: true,
      // Where it actually landed. Said on both paths rather than only on the
      // fallback, because the caller's next sentence often depends on it —
      // "I've sent you the details on Telegram" is wrong when the details went
      // to a DorkOS DM, and neither is inferable from the other fields.
      surface: 'integration',
      subject: outcome.subject,
      adapterId: outcome.adapterId,
      adapterType: outcome.adapterType,
      chatId: outcome.chatId,
      ...(outcome.messageId ? { messageId: outcome.messageId } : {}),
      deliveredTo: outcome.deliveredTo,
    });
  }

  switch (outcome.reason) {
    case 'NO_BINDING':
      return jsonContent(
        {
          sent: false,
          error: channel
            ? `No binding found for channel "${channel}"`
            : 'No adapter bindings found for this agent, and no direct message could be opened with you.',
          availableChannels: outcome.availableChannels,
          code: 'NO_BINDING',
        },
        true
      );
    case 'NO_ACTIVE_SESSIONS':
      return jsonContent(
        {
          sent: false,
          error: channel
            ? 'No active chat sessions found. The user must message the bot first to establish a chat.'
            : 'No active chat sessions found, and no direct message could be opened with you. The user must message the bot first to establish a chat.',
          availableAdapters: outcome.availableAdapters,
          code: 'NO_ACTIVE_SESSIONS',
        },
        true
      );
    case 'INITIATE_NOT_ALLOWED':
      // This verb always INITIATES a message — it is never how an agent replies
      // to an inbound chat message (replies to a <relay_context> turn are
      // forwarded automatically by the runtime adapter, see context-builder.ts).
      // So a false canInitiate on the resolved binding unconditionally blocks
      // this call; it never blocks the automatic reply-forwarding path.
      return jsonContent(
        {
          sent: false,
          error:
            "This integration doesn't allow the agent to start conversations; reply routing still works.",
          code: 'INITIATE_NOT_ALLOWED',
          bindingId: outcome.bindingId,
          adapterId: outcome.adapterId,
        },
        true
      );
    case 'RATE_LIMITED':
      return jsonContent(
        {
          sent: false,
          error: 'You have sent as many notes as you can for now — say it here instead, or wait.',
          code: 'NOTIFY_RATE_LIMITED',
        },
        true
      );
    case 'SEND_FAILED':
      return jsonContent({ sent: false, error: outcome.error, code: 'SEND_FAILED' }, true);
    case 'RELAY_DISABLED':
    case 'BINDINGS_DISABLED':
    case 'NOT_OPTED_IN':
      // Unreachable from this tool: relay and bindings are checked before the
      // pipeline is called, and `agent.note` is declared `always`, never opt-in.
      // Answered rather than thrown, because a refusal an agent cannot parse is
      // worse than one that is merely uninformative.
      return jsonContent(
        { sent: false, error: 'Binding system not available', code: 'BINDINGS_DISABLED' },
        true
      );
  }
}

/**
 * Send a message to a user — on a bound external integration when one can carry
 * it, and otherwise in the caller's direct message with the operator.
 *
 * @param deps - Tool dependencies, including the install's hourly note budget
 *   (`notifyBudget`, DOR-1265) — built once at boot and shared by every session,
 *   which is what makes the ceiling a ceiling rather than a per-session reset.
 * @param identity - Server-injected sender identity; its `agentId` selects the
 *   caller's own integration bindings (never taken from tool args)
 */
export function createRelayNotifyUserHandler(deps: McpToolDeps, identity: SenderIdentity) {
  const budget = deps.notifyBudget;
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

    // Delivered here rather than from inside `notify` because the answer this
    // tool owes the agent depends on WHERE the note landed, and the wording
    // differs between a chat integration and a DorkOS DM. It holds every relay
    // seam already, so it runs the shared delivery and hands the outcome to the
    // pipeline to record.
    const outcome = await deliverOverRelay(
      {
        agentId,
        message: args.message,
        policy: 'always',
        // The same server-injected principal every other send tool uses — a
        // bare agentId is not a relay subject and would match no access rule.
        fromPrincipal: identity.subject,
        ...(args.channel ? { channel: args.channel } : {}),
        dmFallback: true,
        reserve: () => {
          if (budget.tryReserve(agentId)) return true;
          // Nobody is told but the agent. There is no room notice for this —
          // the tool is not a room verb and the person it would be about is the
          // one being protected from it — so this line is the only record a
          // person could later find.
          logRefusal('[relay] an agent has sent as many proactive notes as it may this hour', {
            reason: 'notify_budget',
            visibility: 'silent',
            detail: { agentId, tool: 'relay_notify_user' },
          });
          return false;
        },
        refund: () => budget.refund(agentId),
      },
      {
        relayCore: deps.relayCore,
        bindingStore: deps.bindingStore,
        bindingRouter: deps.bindingRouter,
        ...(deps.adapterManager ? { adapterManager: deps.adapterManager } : {}),
        ...(deps.bridgeStore ? { bridgeStore: deps.bridgeStore } : {}),
        ...(deps.notifyDm ? { notifyDm: deps.notifyDm } : {}),
      }
    );

    const manifest = deps.meshCore?.get(agentId);
    void notify(
      'agent.note',
      {
        agentId,
        agentName: manifest?.displayName ?? manifest?.name ?? 'An agent',
        message: args.message,
      },
      { delivered: outcome }
    );

    return answerFor(outcome, args.channel);
  };
}
