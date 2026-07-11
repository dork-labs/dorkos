/**
 * Authoritative agent→human initiate-consent gate (DOR-277).
 *
 * The DOR-239 consent toggle ("agent may start conversations") is a per-binding
 * permission. Before this gate it was only checked inside the two proactive
 * tool handlers (`relay_notify_user`, the task-completion notifier), so an agent
 * could bypass it by calling `relay_send` / `relay_send_and_wait` /
 * `relay_send_async` with a raw `relay.human.{type}.{adapterId}.{chatId}`
 * subject and deliver straight through to the channel. This module moves the
 * decision down to the relay publish/delivery layer (wired via
 * {@link RelayCore.setInitiateConsentGate}) so EVERY agent→human path is gated,
 * not just those two handlers.
 *
 * ## Principal trust model
 *
 * The publish `from` is a server-injected, unspoofable principal. The gate keys
 * its decision on it:
 *
 * - **Agent-initiated** (`relay.agent.*`, `relay.session.*`, `relay.external.mcp`,
 *   and any other principal not listed below) → GATED. A send to a bound human
 *   channel is denied unless the resolved binding is enabled and `canInitiate`.
 * - **Reply-forwarding** (`agent:*`) → EXEMPT. The runtime adapter republishes an
 *   agent's turn output to the inbound message's `replyTo` (a `relay.human.*`
 *   subject) under the distinct `agent:` principal. This is a reply to a message
 *   the human sent first, never an agent-initiated conversation — exactly the
 *   path DOR-239 preserved.
 * - **System** (`relay.system.*`, e.g. the task-completion notifier
 *   `relay.system.tasks.notifier`) → EXEMPT. System senders already resolved
 *   consent upstream through {@link resolveNotifyTarget} (which enforces the same
 *   `enabled && canInitiate` predicate) before publishing, so re-gating here
 *   would be redundant. The trust boundary: only server-internal code can assert
 *   a `relay.system.*` principal — it is never taken from tool arguments.
 * - **Human** (`relay.human.*`, e.g. inbound bot echoes `relay.human.{type}.{id}.bot`
 *   and the in-app console `relay.human.console.*`) → EXEMPT. These originate from
 *   a human, not an autonomous agent.
 *
 * Only `relay.human.*` targets are subject to the gate at all; `relay.human.console.*`
 * targets are additionally exempt because the in-app console is the operator's own
 * UI (no external binding, no "start a conversation" semantics).
 *
 * @module services/relay/initiate-consent
 */
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import type { InitiateConsentGate } from '@dorkos/relay';
import { parseHumanSubject } from './human-subject.js';

/** Minimal binding-store surface the gate reads. */
export interface ConsentBindingStore {
  /** Resolve the best-matching binding for a human channel target. */
  resolve(adapterId: string, chatId?: string, channelType?: string): AdapterBinding | undefined;
}

/**
 * The shared consent predicate (DOR-239 + DOR-277).
 *
 * A binding permits an agent to INITIATE a conversation only when it is enabled
 * (not paused) AND its per-binding `canInitiate` consent is on. Both the
 * proactive-send resolver ({@link resolveNotifyTarget}) and the delivery-layer
 * {@link createInitiateConsentGate} evaluate consent through this one function,
 * so there is a single consent decision rather than two divergent copies.
 *
 * @param binding - The resolved adapter binding.
 */
export function bindingAllowsInitiate(binding: AdapterBinding): boolean {
  return binding.enabled !== false && binding.canInitiate === true;
}

/**
 * Return true when `from` is an agent-initiated principal — i.e. a principal
 * that must pass the `canInitiate` gate to reach a human channel. Replies,
 * system senders, and human/console principals are not agent-initiated.
 *
 * @param from - The publish `from` principal.
 */
function isAgentInitiatedPrincipal(from: string): boolean {
  if (from.startsWith('agent:')) return false; // reply-forwarding
  if (from.startsWith('relay.system.')) return false; // system (consent resolved upstream)
  if (from.startsWith('relay.human.')) return false; // inbound bot echo / console operator
  return true;
}

/**
 * Build the authoritative agent→human initiate-consent gate.
 *
 * Fail-closed: an agent-initiated principal targeting a `relay.human.*` channel
 * (other than the in-app console) is denied unless a resolved binding for that
 * `{adapterId, chatId}` is both enabled and `canInitiate`. A missing binding is
 * denied too — an agent constructing a raw human subject for a channel it has no
 * enabled, consenting binding to is precisely the side door being closed, and it
 * mirrors the blessed proactive path, which also requires a binding.
 *
 * @param deps - The binding store used to resolve consent.
 */
export function createInitiateConsentGate(deps: {
  bindingStore: ConsentBindingStore;
}): InitiateConsentGate {
  return (from, subject) => {
    // Only agent→human sends are subject to the gate.
    if (!subject.startsWith('relay.human.')) return { allowed: true };
    // The in-app console is the operator's own UI — no binding, no initiate
    // semantics. Never gate it (doing so would deny all console messaging).
    if (subject.startsWith('relay.human.console.')) return { allowed: true };
    // Replies, system, and human principals are not agent-initiated.
    if (!isAgentInitiatedPrincipal(from)) return { allowed: true };

    const { adapterId, chatId, channelType } = parseHumanSubject(subject);
    if (!adapterId) {
      return {
        allowed: false,
        code: 'NO_BINDING',
        reason: `initiate denied: unparseable human subject "${subject}"`,
      };
    }

    const binding = deps.bindingStore.resolve(adapterId, chatId, channelType);
    if (!binding) {
      return {
        allowed: false,
        code: 'NO_BINDING',
        reason: `initiate denied: no binding for adapter "${adapterId}" chat "${chatId ?? ''}"`,
      };
    }

    if (!bindingAllowsInitiate(binding)) {
      return {
        allowed: false,
        code: 'INITIATE_NOT_ALLOWED',
        reason:
          `initiate denied: binding ${binding.id} does not allow the agent to ` +
          `start conversations (canInitiate off or binding paused)`,
      };
    }

    return { allowed: true };
  };
}
