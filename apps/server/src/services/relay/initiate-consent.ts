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
 * agent-initiated and GATED when it targets a bound human channel, and a
 * `relay.agent.*` principal must additionally BE the agent the binding names
 * (see {@link createInitiateConsentGate}). (The console
 * operator's legitimate targets — agents and `relay.human.console.*` — are not
 * gated; only an attempt to start a conversation on an external channel is.)
 *
 * Only `relay.human.*` targets are subject to the gate at all; `relay.human.console.*`
 * targets are additionally exempt because the in-app console is the operator's own
 * UI (no external binding, no "start a conversation" semantics).
 *
 * ## The bridge delivery principal (DOR-871, chats-as-channels §6.4/§6.6)
 *
 * `relay.bridge.{reply|initiate}.{adapterId}.{chatId}` is a SECOND kind of
 * trusted-origin principal, and it is deliberately **not** added to the exempt
 * set above. Where the three exempt principals skip the gate entirely, a
 * `relay.bridge.*` principal is evaluated by a dedicated non-exempt branch
 * (see {@link createInitiateConsentGate}) that enforces `canReply` for an
 * asserted reply and `canInitiate` for an asserted initiate — the two
 * switches this whole module exists to guard, now covering the chat-bridge
 * delivery path too.
 *
 * Trusting the classification asserted IN the principal (rather than deriving
 * it from the entry, which the gate's `(from, subject)` signature cannot see)
 * is safe for exactly one reason: {@link isServerOnlyPrincipal} makes
 * `relay.bridge.*` unassertable by any client of `POST /api/relay/messages`,
 * so the chat-bridge delivery path is the only code that can ever produce
 * one. That route guard and this gate branch are one decision — see
 * `specs/chats-as-channels/design-decisions.md` D-7 amendments 3 and 4 — and
 * must not ship separately.
 *
 * @module services/relay/initiate-consent
 */
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import type { InitiateConsentGate, InitiateConsentDecision } from '@dorkos/relay';
import { requiresInitiateConsent, isConsoleSubject, AGENT_SUBJECT_PREFIX } from '@dorkos/relay';
import { parseHumanSubject } from './human-subject.js';
import { BRIDGE_PRINCIPAL_PREFIX, parseBridgePrincipal } from './bridge-principal.js';

/** Minimal binding-store surface the gate reads. */
export interface ConsentBindingStore {
  /** Resolve the best-matching binding for a human channel target. */
  resolve(adapterId: string, chatId?: string, channelType?: string): AdapterBinding | undefined;
}

/**
 * Look up the relay subject a mesh agent publishes under.
 *
 * The gate is handed a publish principal (`relay.agent.{namespace}.{agentId}`)
 * and a binding that names a mesh agent id. This is the one bridge between
 * them, and it must produce the same subject grammar the sender side does —
 * both go through `subjectForAgent` over an un-stripped registry entry, so they
 * agree by construction. See {@link createAgentSubjectResolver} for why this
 * side reaches the entry by id rather than by project path.
 *
 * @param agentId - The mesh agent id recorded on a binding.
 * @returns That agent's publish subject, or `undefined` if it is not registered.
 */
export type ResolveAgentSubject = (agentId: string) => string | undefined;

/** The one mesh lookup {@link createAgentSubjectResolver} needs. */
export interface ConsentMeshCore {
  /**
   * Registry entry for an agent id, including its canonical relay subject.
   * `relaySubject` is nullable in the mesh's own schema; a null one names
   * nobody, so it is treated exactly like an unregistered agent.
   */
  inspect(agentId: string): { relaySubject: string | null } | undefined;
}

/**
 * Resolve a bound agent's publish subject **by id, straight from the registry**.
 *
 * The obvious spelling of this is `getProjectPath(agentId)` then
 * `getSubjectByPath(path)`, and it is wrong. It turns an id into a path and a
 * path back into an id, and those two are not a bijection: the mesh can hold
 * two agents whose project paths collide (DOR-790), so the round trip can hand
 * back a DIFFERENT agent's subject than the one it was asked about. In a
 * consent gate that is not a stale lookup, it is an authorization decision made
 * about the wrong principal — agent A allowed on agent B's binding.
 *
 * `inspect()` reads the registry entry for that id and builds the subject from
 * it with `subjectForAgent`, the same grammar registration used. No path is
 * involved, so no path collision can reach this. An unregistered id resolves to
 * `undefined`, and the gate denies.
 *
 * @param meshCore - The mesh, or `undefined` when this server has none.
 * @returns A resolver the consent gate can call.
 */
export function createAgentSubjectResolver(
  meshCore: ConsentMeshCore | undefined
): ResolveAgentSubject {
  // No mesh means no agent can be shown to be the bound one, so the gate denies
  // rather than waves through.
  return (agentId) => meshCore?.inspect(agentId)?.relaySubject ?? undefined;
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
 * A binding permits a bridge to REPLY to an inbound platform message only
 * when it is enabled AND its per-binding `canReply` consent is on.
 *
 * Unlike {@link bindingAllowsInitiate}, there was no gate enforcing this
 * before DOR-871: replies rode the blanket `agent:*` exemption, and
 * `canReply` was read only into `__bindingPermissions` alongside
 * `permissionMode`. The `relay.bridge.reply.*` branch in
 * {@link createInitiateConsentGate} is the first thing that actually checks
 * it.
 *
 * @param binding - The resolved adapter binding.
 */
export function bindingAllowsReply(binding: AdapterBinding): boolean {
  return binding.enabled !== false && binding.canReply === true;
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
 * Return true when `from` is a principal only trusted server code may emit —
 * the exempt set above, **plus** `relay.bridge.*` (DOR-871, spec §6.4).
 *
 * This answers a DIFFERENT question from {@link isConsentExemptPrincipal}:
 * "may a client assert this `from` on `POST /api/relay/messages`?" rather
 * than "does the consent gate skip this `from`?". `relay.bridge.*` is
 * deliberately **non-exempt** — the gate evaluates it through the branch in
 * {@link createInitiateConsentGate} that enforces `canReply`/`canInitiate` on
 * the classification the principal carries — but it must still be
 * UNASSERTABLE by a client, or a local caller could construct
 * `relay.bridge.reply.{adapterId}.{chatId}` directly and publish as the bot
 * with no room entry and no external ref, given `canReply` defaults to
 * `true` (`relay-adapter-schemas.ts:475`). That would defeat §9.4's
 * audit-trail guarantee.
 *
 * **`isServerOnlyPrincipal` is used by the HTTP route only** (`routes/relay.ts`).
 * `isConsentExemptPrincipal` keeps its exact three branches and its one
 * meaning — this function does not replace it, and the two must never be
 * collapsed into one (A11.3; `specs/chats-as-channels/design-decisions.md`
 * D-7 amendment 3).
 *
 * @param from - The publish `from` principal.
 */
export function isServerOnlyPrincipal(from: string): boolean {
  return isConsentExemptPrincipal(from) || from.startsWith(BRIDGE_PRINCIPAL_PREFIX);
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
 * ## Consent belongs to a pair, not to a channel
 *
 * `canInitiate` is a switch a person flips for **one agent on one channel**, and
 * that is how the cockpit presents it ("let this agent start conversations
 * here"). Checking only that *some* binding for the channel consents made it a
 * property of the channel instead: every agent and every session on the machine
 * could publish to a raw `relay.human.*` subject and reach that chat as the
 * user's own bot, on a permission a different agent had been granted. So the
 * sender is checked too — a `relay.agent.*` principal must be the agent the
 * resolved binding names, compared through {@link ResolveAgentSubject} against
 * the same subject derivation the sender side uses.
 *
 * Two deliberate calls in that check:
 *
 * - **A principal that is not a mesh agent and not the console is denied.** An
 *   unregistered session (`relay.session.*`) or the external MCP surface
 *   (`relay.external.mcp`) is not the bound agent and cannot become it, so
 *   there is no binding whose consent covers it.
 * - **The in-app console is exempt from the sender check only.** It is the
 *   operator driving their own machine, and they own every binding on it; they
 *   are still subject to `canInitiate`, so a channel switched off stays off.
 *
 * ## Bindings that match more than one chat
 *
 * A binding with no `chatId` matches every chat on its adapter (that is what
 * the field's absence means, and `BindingStore.resolve` scores it accordingly).
 * Sender scoping does not narrow that: the bound agent may still initiate to
 * any chat on that adapter, because that is the scope the person chose when
 * they left the chat filter empty. What it stops is a DIFFERENT agent riding
 * that binding.
 *
 * @param deps - The binding store, and the mesh lookup that maps a bound agent
 *   id to the subject that agent publishes under.
 */
export function createInitiateConsentGate(deps: {
  bindingStore: ConsentBindingStore;
  resolveAgentSubject: ResolveAgentSubject;
}): InitiateConsentGate {
  return (from, subject) => {
    // Only sends to a bound external human channel are subject to the gate.
    // The in-app console is the operator's own UI — no binding, no initiate
    // semantics — and `requiresInitiateConsent` carves it out.
    if (!requiresInitiateConsent(subject)) return { allowed: true };

    // DOR-871: the chat-bridge delivery principal — one new NON-EXEMPT branch
    // (A11.3: the exempt set above is untouched). Checked ahead of
    // `isConsentExemptPrincipal` for clarity, though that predicate already
    // answers `false` for this prefix: `relay.bridge.*` is evaluated, never
    // skipped. Safe only because `isServerOnlyPrincipal` makes it unassertable
    // by a client (see that function's doc, and D-7 amendments 3+4).
    if (from.startsWith(BRIDGE_PRINCIPAL_PREFIX)) {
      return checkBridgePrincipal(from, subject, deps.bindingStore);
    }

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

    return checkSender(from, binding, deps.resolveAgentSubject);
  };
}

/**
 * Confirm the sender is the agent this binding's consent was granted to.
 *
 * @param from - The publish principal.
 * @param binding - The binding whose consent was just checked.
 * @param resolveAgentSubject - Mesh lookup: bound agent id → publish subject.
 */
function checkSender(
  from: string,
  binding: AdapterBinding,
  resolveAgentSubject: ResolveAgentSubject
): ReturnType<InitiateConsentGate> {
  // The operator's own UI. They own every binding here; `canInitiate` above is
  // the switch that still applies to them.
  if (isConsoleSubject(from)) {
    return { allowed: true };
  }

  if (!from.startsWith(AGENT_SUBJECT_PREFIX)) {
    return {
      allowed: false,
      code: 'INITIATE_NOT_ALLOWED',
      reason:
        `initiate denied: "${from}" is not a registered agent, so no binding's ` +
        `consent covers it`,
    };
  }

  const boundSubject = resolveAgentSubject(binding.agentId);
  if (!boundSubject) {
    return {
      allowed: false,
      code: 'NO_BINDING',
      reason:
        `initiate denied: binding ${binding.id} names agent "${binding.agentId}", ` +
        `which is not registered in the mesh`,
    };
  }

  if (boundSubject !== from) {
    return {
      allowed: false,
      code: 'INITIATE_NOT_ALLOWED',
      reason:
        `initiate denied: binding ${binding.id} lets "${boundSubject}" start ` +
        `conversations here, not "${from}"`,
    };
  }

  return { allowed: true };
}

/**
 * The gate's one new non-exempt branch: `relay.bridge.*` (DOR-871, spec
 * §6.6). Enforces exactly `enabled && (canReply | canInitiate)` on the
 * classification the principal asserts — nothing else. Provenance
 * classification (was this really a reply?) and the delivering-author check
 * are `deliver`'s job (task 1.8), not this gate's: `InitiateConsentGate` is
 * `(from, subject) => decision`, so this branch cannot see the entry, its
 * `cascadeRoot`, or who is delivering.
 *
 * Decision table:
 *
 * | Step                                             | Failure                                                  |
 * | ------------------------------------------------- | --------------------------------------------------------- |
 * | Parse `from` as a bridge principal                 | unrecognized/malformed classification → `INITIATE_NOT_ALLOWED` (denied, never defaulted) |
 * | Parse `{adapterId, chatId}` from the target subject | unparseable `relay.human.*` subject → `NO_BINDING`        |
 * | Resolve the binding                                | none for `(adapterId, chatId)` → `NO_BINDING`             |
 * | classification `'reply'`                           | `bindingAllowsReply` false → `INITIATE_NOT_ALLOWED`        |
 * | classification `'initiate'`                        | `bindingAllowsInitiate` false → `INITIATE_NOT_ALLOWED`     |
 * | otherwise                                          | `{ allowed: true }`                                        |
 *
 * @param from - The publish principal; already known to start with
 *   {@link BRIDGE_PRINCIPAL_PREFIX}.
 * @param subject - The target `relay.human.*` subject.
 * @param bindingStore - Resolves the binding for the target channel.
 */
function checkBridgePrincipal(
  from: string,
  subject: string,
  bindingStore: ConsentBindingStore
): InitiateConsentDecision {
  const parsed = parseBridgePrincipal(from);
  if (!parsed) {
    // Unrecognized/malformed classification segment: deny rather than default
    // to either reply or initiate (spec §6.6 point 1).
    return {
      allowed: false,
      code: 'INITIATE_NOT_ALLOWED',
      reason: `bridge delivery denied: unrecognized bridge principal "${from}"`,
    };
  }

  const { adapterId, chatId, channelType } = parseHumanSubject(subject);
  if (!adapterId) {
    return {
      allowed: false,
      code: 'NO_BINDING',
      reason: `bridge delivery denied: unparseable human subject "${subject}"`,
    };
  }

  const binding = bindingStore.resolve(adapterId, chatId, channelType);
  if (!binding) {
    return {
      allowed: false,
      code: 'NO_BINDING',
      reason: `bridge delivery denied: no binding for adapter "${adapterId}" chat "${chatId ?? ''}"`,
    };
  }

  if (parsed.classification === 'reply') {
    if (bindingAllowsReply(binding)) return { allowed: true };
    return {
      allowed: false,
      code: 'INITIATE_NOT_ALLOWED',
      reason:
        `bridge reply denied: binding ${binding.id} does not allow replies ` +
        `(canReply off or binding paused)`,
    };
  }

  // classification === 'initiate'
  if (bindingAllowsInitiate(binding)) return { allowed: true };
  return {
    allowed: false,
    code: 'INITIATE_NOT_ALLOWED',
    reason:
      `bridge initiate denied: binding ${binding.id} does not allow the agent to ` +
      `start conversations (canInitiate off or binding paused)`,
  };
}
