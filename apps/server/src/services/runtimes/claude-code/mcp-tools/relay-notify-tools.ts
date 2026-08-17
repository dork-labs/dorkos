/**
 * The `relay_notify_user` MCP tool handler.
 *
 * Split out of `relay-tools.ts`: every other Relay tool speaks to the message
 * bus, while this one reaches a person — on an external chat channel when one
 * is connected, and in DorkOS's own direct messages when none is — and pulls in
 * the binding store, binding router, adapter manager and rooms to do it.
 *
 * **An external integration is still first preference**, unchanged: if a bound
 * Telegram or Slack chat resolves, the message goes there under exactly the
 * rules it always did. The DM is what happens instead of nothing (DOR-1209).
 *
 * **What bounds it is an hourly count, not a card** (DOR-1265). This verb no
 * longer raises an approval prompt for an agent-identified session — one raised
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
 * the switch.
 *
 * @module services/runtimes/claude-code/mcp-tools/relay-notify-tools
 */
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';
import { requireRelay, type SenderIdentity } from './relay-helpers.js';
import { resolveNotifyTarget, type NotifyTarget } from '../../../relay/notify-target.js';
import { buildBridgePrincipal } from '../../../relay/bridge-principal.js';
import { deliverNotifyDm, type NotifyDmDeps } from '../../../relay/notify-dm.js';
import type { NotifyBudget } from '../../../relay/notify-budget.js';
import { logRefusal } from '../../../observability/refusals.js';

/**
 * Whether a failed integration lookup should fall back to the operator's DM.
 *
 * Two conditions, and each rules out a fallback that would be a surprise rather
 * than a rescue:
 *
 * - **Nothing was addressable.** `NO_BINDING` and `NO_ACTIVE_SESSIONS` are the
 *   two shapes of "this install has no chat integration that can carry this",
 *   which is the stock-install state this fallback exists for.
 *   `INITIATE_NOT_ALLOWED` is not one of them: somebody turned "Agent can start
 *   conversations" OFF on the binding the message resolved to, and routing
 *   around a switch a person set would be worse than not delivering. It still
 *   refuses, exactly as before.
 * - **The caller did not name a channel.** `channel: 'telegram'` is a request
 *   for a specific place; answering it with a DorkOS DM would silently deliver
 *   somewhere the caller did not ask for. The error is more useful — it tells
 *   the agent to try again without a channel, which then reaches the DM.
 *
 * @param target - The failed resolution.
 * @param channel - The channel the caller asked for, if it asked for one.
 */
function shouldFallBackToDm(
  target: Extract<NotifyTarget, { ok: false }>,
  channel: string | undefined
): boolean {
  if (channel) return false;
  return target.reason === 'NO_BINDING' || target.reason === 'NO_ACTIVE_SESSIONS';
}

/**
 * Deliver into the agent's DM with the operator, or answer `null` when the DM
 * refused the write (already logged by {@link deliverNotifyDm}).
 *
 * **Charges the hour only for a note that LANDED.** The reservation is taken
 * first, so two notes decided in the same tick cannot both take the last one,
 * and it is given back when the write did not happen. Giving it back is exact
 * here and nowhere else: `deliverNotifyDm` is local, synchronous and returns a
 * structured outcome, and there is no `await` between the two calls — so the
 * timestamp refunded is provably the one this call reserved, and "did it land"
 * is a question with an answer. Contrast the external adapter path below, which
 * charges before publishing and never refunds: that message goes off this
 * machine, so a throw or a timeout does not mean it failed to arrive, and
 * refunding on one would hand back a note the person already read.
 *
 * The DM path is the one that had to be exact, because it is the one a stock
 * install uses: an agent the mesh cannot place fails every time, and charging
 * for those would spend a person's whole hour on notes nobody received, then
 * report it as being too chatty.
 *
 * @param notifyDm - The rooms/authors/mesh seam. The caller checks it is there
 *   before spending a note on it: an install with rooms unwired has nowhere to
 *   deliver, and a call that could never land must cost nothing.
 * @param budget - The hourly allowance, reserved and given back around the write.
 * @param agentId - The server-resolved sender.
 * @param message - What to say.
 */
function tryDm(notifyDm: NotifyDmDeps, budget: NotifyBudget, agentId: string, message: string) {
  const outcome = deliverNotifyDm({ agentId, message }, notifyDm);
  if (!outcome.ok) {
    budget.refund(agentId);
    return null;
  }
  return jsonContent({
    sent: true,
    surface: 'dorkos-dm',
    roomId: outcome.roomId,
    entryId: outcome.entryId,
  });
}

/**
 * Take one note off this agent's hourly allowance, or say it has none left.
 *
 * Called immediately before a message is handed to a transport, so a call
 * refused for any other reason — no binding, a channel that resolves to nothing,
 * an owner who never switched initiating on — costs nothing.
 *
 * The refusal is written for the agent to ACT on: it names the alternative it
 * has (say it in the conversation it is already in) and the fact that the
 * allowance comes back, so the honest response is not to retry the same call.
 *
 * @param budget - The install's rolling per-agent count.
 * @param agentId - The server-resolved sender.
 * @returns The refusal to return to the model, or `null` to carry on.
 */
function refuseIfSpent(budget: NotifyBudget, agentId: string) {
  if (budget.tryReserve(agentId)) return null;
  // Nobody is told but the agent. There is no room notice for this — the tool is
  // not a room verb and the person it would be about is the one being protected
  // from it — so this line is the only record a person could later find.
  logRefusal('[relay] an agent has sent as many proactive notes as it may this hour', {
    reason: 'notify_budget',
    visibility: 'silent',
    detail: { agentId, tool: 'relay_notify_user' },
  });
  return jsonContent(
    {
      sent: false,
      error: 'You have sent as many notes as you can for now — say it here instead, or wait.',
      code: 'NOTIFY_RATE_LIMITED',
    },
    true
  );
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
      // Nothing external can carry this. On a stock install — nobody has
      // connected Telegram or Slack — that used to be the end of it, and the
      // person heard nothing at all. DorkOS's own direct messages are the
      // surface that is always there, so the message goes to the one this agent
      // shares with the operator (DOR-1209). A DM that cannot be reached falls
      // through to the same errors as before, already logged by `deliverNotifyDm`.
      if (shouldFallBackToDm(target, args.channel) && deps.notifyDm) {
        const spent = refuseIfSpent(budget, agentId);
        if (spent) return spent;
        const delivered = tryDm(deps.notifyDm, budget, agentId, args.message);
        if (delivered) return delivered;
      }
      switch (target.reason) {
        case 'NO_BINDING':
          return jsonContent(
            {
              sent: false,
              error: args.channel
                ? `No binding found for channel "${args.channel}"`
                : 'No adapter bindings found for this agent, and no direct message could be opened with you.',
              availableChannels: target.availableChannels,
              code: 'NO_BINDING',
            },
            true
          );
        case 'NO_ACTIVE_SESSIONS':
          return jsonContent(
            {
              sent: false,
              // The DM half is said only when a DM was actually tried. Naming a
              // channel skips the fallback, and an error that claimed a DM had
              // failed would send the caller looking for a room nobody opened.
              error: args.channel
                ? 'No active chat sessions found. The user must message the bot first to establish a chat.'
                : 'No active chat sessions found, and no direct message could be opened with you. The user must message the bot first to establish a chat.',
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

    // Asked here rather than at the top of the handler: everything above this
    // line is a refusal, and a caller that was going to be refused anyway must
    // not have a note taken off it on the way out.
    const spent = refuseIfSpent(budget, agentId);
    if (spent) return spent;

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
        // A bridged target publishes under `relay.bridge.initiate.*`; assert the
        // DOR-889 trust marker so the pipeline guard admits this trusted server
        // publisher. Inert (and omitted) on the agent's own identity subject.
        ...(target.bridged ? { serverBridgePrincipal: true } : {}),
      });
      return jsonContent({
        sent: true,
        // Where it actually landed. Said on both paths rather than only on the
        // fallback, because the caller's next sentence often depends on it —
        // "I've sent you the details on Telegram" is wrong when the details
        // went to a DorkOS DM, and neither is inferable from the other fields.
        surface: 'integration',
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
