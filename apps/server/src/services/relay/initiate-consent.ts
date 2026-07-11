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
 * {@link RelayCore.setInitiateConsentGate}) so the gate covers every publish
 * path — `relay_send*`, A2A, binding-router re-dispatch — not just those two
 * handlers.
 *
 * ## Principal trust model
 *
 * The gate keys its decision on the publish `from`. That principal is only
 * trustworthy where the server injects it and refuses to let a caller assert it:
 *
 * - On the agent tool surface, `resolveSenderIdentity` derives `from` from the
 *   session (never from tool args), so an LLM cannot spoof it.
 * - The task-completion notifier and adapter reply-forwarding are server-internal
 *   and assert their own principals.
 * - The one entry point that takes a client-supplied `from` — the HTTP route
 *   `POST /api/relay/messages` — rejects any principal in the exempt set below
 *   via {@link isConsentExemptPrincipal}, so an untrusted local caller cannot
 *   assert one to slip past the gate.
 *
 * The exempt set — principals only trusted server code emits, never gated:
 *
 * - **Reply-forwarding** (`agent:*`) → EXEMPT. The runtime adapter republishes an
 *   agent's turn output to the inbound message's `replyTo` (a `relay.human.*`
 *   subject) under the distinct `agent:` principal. This is a reply to a message
 *   the human sent first, never an agent-initiated conversation — exactly the
 *   path DOR-239 preserved.
 * - **System** (`relay.system.*`, e.g. the task-completion notifier
 *   `relay.system.tasks.notifier`) → EXEMPT. System senders already resolved
 *   consent upstream through {@link resolveNotifyTarget} (which enforces the same
 *   `enabled && canInitiate` predicate) before publishing.
 * - **Inbound adapter echo** (`relay.human.{type}.{adapterId}.bot`) → EXEMPT.
 *   Telegram/Slack adapters publish an inbound human message onto the bus under
 *   this `.bot` principal so BindingRouter can route it to the agent; gating it
 *   would break inbound delivery. This is a human messaging IN, not an agent
 *   messaging out.
 *
 * Every other principal — `relay.agent.*`, `relay.session.*`, `relay.external.mcp`,
 * the in-app console `relay.human.console`, or anything else — is treated as
 * agent-initiated and GATED when it targets a bound human channel. (The console
 * operator's legitimate targets — agents and `relay.human.console.*` — are not
 * gated; only an attempt to start a conversation on an external channel is.)
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
 * Return true when `from` is a principal only trusted server code emits, and
 * which the consent gate therefore exempts: reply-forwarding (`agent:*`), system
 * senders (`relay.system.*`), and inbound adapter echoes
 * (`relay.human.{type}.{adapterId}.bot`).
 *
 * This is the single source of truth for the exempt set. The consent gate uses
 * it to decide exemption; the HTTP publish route uses it to REJECT a
 * client-asserted `from` in this set (an untrusted caller must never be able to
 * assert a trusted principal and slip past the gate — DOR-277 review follow-up).
 *
 * Note the in-app console principal (`relay.human.console`) is deliberately NOT
 * exempt: it is gated like any agent-initiated principal, so neither the operator
 * nor a spoofer can start a conversation on an external channel when `canInitiate`
 * is off. Its legitimate targets (agents, `relay.human.console.*`) are not gated.
 *
 * @param from - The publish `from` principal.
 */
export function isConsentExemptPrincipal(from: string): boolean {
  if (from.startsWith('agent:')) return true; // reply-forwarding
  if (from.startsWith('relay.system.')) return true; // system (consent resolved upstream)
  // Inbound adapter echo: `relay.human.{type}.{adapterId}.bot`. NOT the console.
  if (from.startsWith('relay.human.') && from.endsWith('.bot')) return true;
  return false;
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
    // Trusted server-injected principals (replies, system, inbound bot echoes)
    // are not agent-initiated.
    if (isConsentExemptPrincipal(from)) return { allowed: true };

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
