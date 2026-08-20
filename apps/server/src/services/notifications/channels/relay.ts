/**
 * The relay channel — how a notification leaves DorkOS and reaches a person on
 * Telegram, Slack, or in their own direct messages (spec `notification-system`).
 *
 * **This is one implementation of a delivery that used to be two.** The
 * `relay_notify_user` MCP tool and the DOR-240 task-completion notifier resolved
 * the same binding, honored the same `canInitiate` consent gate and published
 * through the same relay, in two copies that had already drifted (only one of
 * them could fall back to a DorkOS DM; only one of them spent the hourly
 * budget). They are now one path, and the differences between them are
 * parameters rather than duplicated code.
 *
 * Nothing about the consent story changes here. The binding still has to exist,
 * be enabled, have a live chat, and have "Agent can start conversations"
 * switched on. A bridged chat still publishes under the bridge principal so it
 * is gated as an INITIATE rather than slipping past under a system exemption.
 *
 * **The per-agent hourly budget changed, and deliberately.** It is spent once a
 * send is a real attempt to reach somebody — after the two refusals that are the
 * operator's own decision, and before any transport is tried — and there is no
 * refund. It used to be charged only for a note that LANDED, which sounded
 * fairer and was: on a stock install nothing external resolves, so every note
 * was refunded, the ceiling could never be reached, and once notes started
 * leaving inbox rows behind (DOR-1383) a looping agent could fill a person's
 * inbox without ever appearing to have spent anything. The allowance bounds how
 * often an agent may interrupt somebody, not how often it succeeds.
 *
 * @module services/notifications/channels/relay
 */
import { resolveNotifyTarget } from '../../relay/notify-target.js';
import type {
  NotifyTargetBindingStore,
  NotifyTargetBindingRouter,
  NotifyTargetAdapterManager,
  NotifyTargetBridgeStore,
} from '../../relay/notify-target.js';
import { buildBridgePrincipal } from '../../relay/bridge-principal.js';
import { deliverNotifyDm, type NotifyDmDeps } from '../../relay/notify-dm.js';
import { isRelayEnabled } from '../../relay/relay-state.js';
import type { RelayPolicy } from '../notification-registry.js';

/** The relay publish surface this channel needs, and nothing more. */
export interface RelayChannelPublisher {
  publish(
    subject: string,
    payload: unknown,
    options: {
      from: string;
      budget?: { maxHops?: number; ttl?: number; callBudgetRemaining?: number };
      serverBridgePrincipal?: boolean;
    }
  ): Promise<{ deliveredTo: number; messageId?: string }>;
}

/** What the channel needs wired at boot to be able to deliver anything. */
export interface RelayChannelDeps {
  bindingStore?: NotifyTargetBindingStore;
  bindingRouter?: NotifyTargetBindingRouter;
  adapterManager?: NotifyTargetAdapterManager;
  /** Live bridge rows, so a bridged chat resolves once its session vacates the map. */
  bridgeStore?: NotifyTargetBridgeStore;
  relayCore?: RelayChannelPublisher;
  /** The DorkOS-DM fallback seam. Absent on an install with rooms unwired. */
  notifyDm?: NotifyDmDeps;
  /** Overridable for tests; defaults to the global relay feature flag. */
  isRelayEnabled?: () => boolean;
}

/** The per-send decisions the registry cannot make for a caller. */
export interface RelayDeliveryRequest {
  /** Whose bindings to resolve. Always the server's own answer, never a model's. */
  agentId: string;
  /** Exactly what the person reads. */
  message: string;
  /** Whether this kind may go out at all, and on what terms. */
  policy: RelayPolicy;
  /** The relay principal to publish under when the chat is not bridged. */
  fromPrincipal: string;
  /** A specific adapter or type the caller asked for. Suppresses the DM fallback. */
  channel?: string;
  /** Whether a DorkOS DM is an acceptable landing place when nothing external resolves. */
  dmFallback?: boolean;
  /** Relay-pipeline budget for the publish itself. */
  publishBudget?: { maxHops?: number; ttl?: number; callBudgetRemaining?: number };
  /**
   * Take one off the sender's hourly allowance, or report that it has none left.
   *
   * Called once a send is a real attempt to reach somebody — after the two
   * refusals that are the operator's own decision (`INITIATE_NOT_ALLOWED` and
   * `NOT_OPTED_IN`) and before any transport is tried, so a note that reaches
   * nobody still costs the hour and a note the operator switched off costs
   * nothing. There is no refund; see {@link tryDm}.
   *
   * Omitted where the sender is the system rather than an agent — a scheduled
   * run reporting its own result is not an agent choosing to interrupt
   * somebody, and DOR-240 never counted it.
   */
  reserve?: () => boolean;
}

/** Where a notification went, or why it could not go anywhere. */
export type RelayDeliveryOutcome =
  | {
      ok: true;
      surface: 'integration';
      subject: string;
      adapterId: string;
      adapterType: string;
      chatId: string;
      messageId?: string;
      deliveredTo: number;
    }
  | { ok: true; surface: 'dorkos-dm'; roomId: string; entryId: string }
  | { ok: false; reason: 'RELAY_DISABLED' }
  | { ok: false; reason: 'BINDINGS_DISABLED' }
  | { ok: false; reason: 'NOT_OPTED_IN'; bindingId: string; adapterId: string }
  | { ok: false; reason: 'RATE_LIMITED' }
  | { ok: false; reason: 'NO_BINDING'; availableChannels: string[] }
  | { ok: false; reason: 'NO_ACTIVE_SESSIONS'; availableAdapters: string[] }
  | { ok: false; reason: 'INITIATE_NOT_ALLOWED'; bindingId: string; adapterId: string }
  | { ok: false; reason: 'SEND_FAILED'; error: string };

/**
 * Whether a failed integration lookup should fall back to the operator's DM.
 *
 * Two conditions, each ruling out a fallback that would be a surprise rather
 * than a rescue. `NO_BINDING` and `NO_ACTIVE_SESSIONS` are the two shapes of
 * "this install has no chat integration that can carry this", which is the
 * stock-install state the fallback exists for. `INITIATE_NOT_ALLOWED` is not one
 * of them: somebody turned "Agent can start conversations" OFF on the binding
 * this resolved to, and routing around a switch a person set would be worse than
 * not delivering. And a caller that named a channel asked for a specific place;
 * answering that with a DorkOS DM would deliver somewhere nobody asked for.
 */
function shouldFallBackToDm(
  reason: 'NO_BINDING' | 'NO_ACTIVE_SESSIONS' | 'INITIATE_NOT_ALLOWED',
  request: RelayDeliveryRequest
): boolean {
  if (!request.dmFallback) return false;
  if (request.channel) return false;
  return reason === 'NO_BINDING' || reason === 'NO_ACTIVE_SESSIONS';
}

/**
 * Send one notification out over a connected chat integration, or into the
 * agent's direct message with the operator.
 *
 * Never throws — a delivery problem must never fail the thing that produced the
 * notification.
 *
 * @param request - Who is sending, what it says, and on what terms.
 * @param deps - The relay, binding and rooms seams, as boot wired them.
 */
export async function deliverOverRelay(
  request: RelayDeliveryRequest,
  deps: RelayChannelDeps
): Promise<RelayDeliveryOutcome> {
  if (request.policy === 'never') return { ok: false, reason: 'RELAY_DISABLED' };

  const relayOn = deps.isRelayEnabled ?? isRelayEnabled;
  if (!relayOn()) return { ok: false, reason: 'RELAY_DISABLED' };

  const { relayCore, bindingStore, bindingRouter } = deps;
  if (!relayCore || !bindingStore || !bindingRouter) {
    return { ok: false, reason: 'BINDINGS_DISABLED' };
  }

  const target = resolveNotifyTarget(request.agentId, {
    bindingStore,
    bindingRouter,
    adapterManager: deps.adapterManager,
    bridgeStore: deps.bridgeStore,
    ...(request.channel ? { channel: request.channel } : {}),
  });

  if (!target.ok) {
    // Somebody turned "Agent can start conversations" OFF. That is a decision,
    // not a missing integration: it costs the sender nothing, and — because the
    // pipeline drops the row too — it silences the note on every surface rather
    // than only on the chat one. Returned before the allowance is touched.
    if (target.reason === 'INITIATE_NOT_ALLOWED') {
      return {
        ok: false,
        reason: 'INITIATE_NOT_ALLOWED',
        bindingId: target.bindingId,
        adapterId: target.adapterId,
      };
    }

    // Everything below here is a REAL attempt to reach somebody, so it costs one
    // off the hour whether or not it lands.
    //
    // This is the opposite of what DOR-1265 originally did, and the reason is a
    // hole that only appeared once notes started leaving rows behind: on a stock
    // install nothing external resolves, so every note took this branch, and
    // refunding each one made the ceiling unreachable. An agent in a loop could
    // then write unbounded rows into a person's inbox while never appearing to
    // have said anything at all. The allowance bounds the SAYING, not the
    // arriving.
    if (request.reserve && !request.reserve()) return { ok: false, reason: 'RATE_LIMITED' };

    if (shouldFallBackToDm(target.reason, request) && deps.notifyDm) {
      const viaDm = tryDm(deps.notifyDm, request);
      if (viaDm) return viaDm;
    }
    return target.reason === 'NO_BINDING'
      ? { ok: false, reason: 'NO_BINDING', availableChannels: target.availableChannels }
      : { ok: false, reason: 'NO_ACTIVE_SESSIONS', availableAdapters: target.availableAdapters };
  }

  // The opt-in gate, asked before anything is spent: a success the operator did
  // not ask to hear about must cost neither a note nor a publish.
  if (request.policy === 'opt-in' && !target.notifyOnTaskComplete) {
    return {
      ok: false,
      reason: 'NOT_OPTED_IN',
      bindingId: target.bindingId,
      adapterId: target.adapterId,
    };
  }

  if (request.reserve && !request.reserve()) return { ok: false, reason: 'RATE_LIMITED' };

  try {
    // A bridged chat publishes under the bridge delivery principal rather than
    // the caller's own, so a proactive send still reads as an INITIATE through
    // the bridge consent branch instead of riding past it unlabeled.
    const from = target.bridged
      ? buildBridgePrincipal('initiate', target.adapterId, target.chatId)
      : request.fromPrincipal;
    const result = await relayCore.publish(target.subject, request.message, {
      from,
      ...(request.publishBudget ? { budget: request.publishBudget } : {}),
      // Assert the DOR-889 trust marker so the pipeline guard admits this
      // trusted server publisher. Inert (and omitted) off the bridge path.
      ...(target.bridged ? { serverBridgePrincipal: true } : {}),
    });
    return {
      ok: true,
      surface: 'integration',
      subject: target.subject,
      adapterId: target.adapterId,
      adapterType: target.adapterType,
      chatId: target.chatId,
      ...(result.messageId ? { messageId: result.messageId } : {}),
      deliveredTo: result.deliveredTo,
    };
  } catch (err) {
    // No refund: the message left this machine, so a throw or a timeout does not
    // prove it failed to arrive, and giving the allowance back would hand back a
    // note the person may already have read.
    return {
      ok: false,
      reason: 'SEND_FAILED',
      error: err instanceof Error ? err.message : 'Send failed',
    };
  }
}

/**
 * Deliver into the agent's DM with the operator, or answer `null` when the DM
 * refused the write (already logged by `deliverNotifyDm`).
 *
 * The allowance is already spent by the time this runs, and there is no refund:
 * a note the mesh could not place still occupied the hour, because what the
 * ceiling bounds is how often an agent may INTERRUPT a person, not how often it
 * succeeds at it. A refund here is exactly what let a stock install — where
 * nothing external resolves and every note takes this path — produce unbounded
 * inbox rows while never appearing to have spent anything.
 */
function tryDm(notifyDm: NotifyDmDeps, request: RelayDeliveryRequest): RelayDeliveryOutcome | null {
  const outcome = deliverNotifyDm({ agentId: request.agentId, message: request.message }, notifyDm);
  if (!outcome.ok) return null;
  return { ok: true, surface: 'dorkos-dm', roomId: outcome.roomId, entryId: outcome.entryId };
}
