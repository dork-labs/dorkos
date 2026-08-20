/**
 * Shared target-resolution for proactive, agent-initiated messages.
 *
 * Resolves the best bound integration an agent may INITIATE a message on: filter the
 * agent's non-paused bindings (optionally by channel), pick the most-recently
 * active chat session, enforce the `canInitiate` consent gate (DOR-239), and
 * build the `relay.human.*` publish subject. Every proactive send resolves
 * through this one function, so the `relay_notify_user` MCP tool and the
 * system's own task-completion message honor identical binding, session and
 * consent rules. Both now reach it through the notification pipeline's relay
 * channel (`services/notifications/channels/relay.ts`, DOR-1383), which is the
 * single implementation of the publish those two used to keep two copies of.
 *
 * A bridged binding (`bridge: 'room'`) vacates `sessionMap` (chats-as-channels
 * spec §7.2), so `pickMostRecentChat` also considers live bridge rows as
 * recency candidates (§7.5) — otherwise a bridged chat could never win and a
 * proactive notice would silently stop reaching it. The resolved `bridged`
 * flag on a successful result tells the caller to publish under the
 * `relay.bridge.initiate.*` principal instead of its own, so the send is still
 * gated as an initiate rather than riding an exemption that was never meant to
 * cover it (see `buildBridgePrincipal` in `bridge-principal.ts` and the
 * non-exempt branch it feeds in `initiate-consent.ts`).
 *
 * @module services/relay/notify-target
 */
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import { bindingAllowsInitiate } from './initiate-consent.js';

/** Minimal binding-store surface the resolver reads. */
export interface NotifyTargetBindingStore {
  getAll(): AdapterBinding[];
}

/** Minimal binding-router surface — active chat sessions for a binding. */
export interface NotifyTargetBindingRouter {
  getSessionsByBinding(bindingId: string): Array<{
    /** Whether the session belongs to a chat or to one person. */
    scope: 'chat' | 'user';
    /** Present when `scope` is `'chat'`. */
    chatId?: string;
    /** Present when `scope` is `'user'`. */
    userId?: string;
    sessionId: string;
    /** Epoch ms of the last message through this session; 0 if never observed. */
    lastActivityAt: number;
  }>;
}

/** Minimal adapter-manager surface — resolves an adapter id to its type. */
export interface NotifyTargetAdapterManager {
  listAdapters(): Array<{ config: { id: string; type: string } }>;
}

/**
 * Minimal bridge-store surface the resolver reads — live bridge rows compete
 * as recency candidates alongside `sessionMap` sessions (§7.5).
 */
export interface NotifyTargetBridgeStore {
  /**
   * Every live (non-archived) bridge, across every binding and adapter. The
   * resolver filters this down to rows whose `bindingId` names one of the
   * agent's own eligible bindings — mirroring how the session loop already
   * scopes `bindingRouter.getSessionsByBinding` to those same bindings.
   */
  listLiveBridges(): Array<{
    /** The binding this bridge is attached to. */
    bindingId: string;
    /** The platform chat id the room projects to. */
    chatId: string;
    /** ISO 8601 timestamp of the bridge's last inbound or delivered activity; `null` if never. */
    lastActivityAt: string | null;
  }>;
}

/** Dependencies for {@link resolveNotifyTarget}. */
export interface NotifyTargetDeps {
  bindingStore: NotifyTargetBindingStore;
  bindingRouter: NotifyTargetBindingRouter;
  /** Optional — used for channel-by-type filtering and adapter-type lookup. */
  adapterManager?: NotifyTargetAdapterManager;
  /**
   * Optional — live bridge rows considered alongside `sessionMap` sessions as
   * recency candidates (§7.5). Undefined behaves exactly as before bridging
   * existed: only `sessionMap` sessions are considered.
   */
  bridgeStore?: NotifyTargetBridgeStore;
  /** Optional adapter type or id to target (e.g. "telegram", "telegram-lifeos"). */
  channel?: string;
}

/**
 * Resolution outcome. `ok:true` carries everything a caller needs to publish;
 * each `ok:false` reason mirrors the tool error codes the resolver replaced,
 * so `relay_notify_user` can map them back to its existing responses unchanged,
 * while the notifier treats any failure as a silent no-op.
 */
export type NotifyTarget =
  | {
      ok: true;
      subject: string;
      adapterId: string;
      adapterType: string;
      chatId: string;
      bindingId: string;
      /** The resolved binding's per-integration task-completion opt-in (DOR-240). */
      notifyOnTaskComplete: boolean;
      /**
       * Whether this target was resolved via a live bridge row rather than a
       * `sessionMap` session (§7.5). A caller MUST publish under
       * `buildBridgePrincipal('initiate', adapterId, chatId)` when this is
       * `true`, rather than its own principal — `subject` alone does not
       * carry that distinction. This keeps every bridge-routed send legible
       * under the one `relay.bridge.*` classification DOR-871 established
       * (A7.5), instead of a proactive notice being indistinguishable from
       * any other send once it lands under a generic system/agent
       * principal. `canInitiate` was already checked below either way — the
       * principal choice does not change whether the send is allowed.
       */
      bridged: boolean;
    }
  | { ok: false; reason: 'NO_BINDING'; availableChannels: string[] }
  | { ok: false; reason: 'NO_ACTIVE_SESSIONS'; availableAdapters: string[] }
  | { ok: false; reason: 'INITIATE_NOT_ALLOWED'; bindingId: string; adapterId: string };

/**
 * Pick the chat this agent spoke in most recently, across its eligible bindings.
 *
 * ## Two things this had wrong
 *
 * It took `sessions[sessions.length - 1]` from the last binding that had any
 * session at all — file order, not recency — while its own doc promised "the
 * most-recently-active chat session". A task-completion notice therefore landed
 * wherever the session file happened to end, which in practice was a public
 * channel somebody had used once, not the DM they were working in. Sessions now
 * carry `lastActivityAt`, maintained by `BindingRouter` on every routed
 * message, and this sorts on it.
 *
 * It also read every session's key tail as a chat id. Under the `per-user`
 * strategy that tail is a **person**, and a person's id is not a chat: on Slack
 * it is a `U…` where the conversation is a `D…`, and on a group binding it
 * would divert a group notification into a private message. A per-user session
 * is therefore only usable when its binding names the chat to speak in; when it
 * does not, we know who was active but not where, and that candidate is skipped
 * rather than guessed at.
 *
 * ## A live bridge also counts as an active chat (§7.5)
 *
 * A binding with `bridge: 'room'` vacates `sessionMap` (§7.2) — bridging
 * adopts or starts a room session and removes the `sessionMap` entry, so the
 * loop above never sees it again. Left unfixed, a bridged chat would look
 * exactly like one that was never active, and `resolveNotifyTarget` would
 * report `NO_ACTIVE_SESSIONS` for a chat someone is actively using. So a
 * second pass considers `bridgeStore.listLiveBridges()`, each row
 * contributing a candidate `{ binding, chatId, at: bridge.lastActivityAt }` —
 * `lastActivityAt` is an ISO 8601 string here (stamped by `ingest` and by
 * successful delivery) rather than the epoch-ms number sessions carry, so it
 * is parsed before competing on the same recency axis.
 *
 * This pass runs strictly after the session pass and only replaces `best` on
 * a **strict** improvement (`at > best.at`, never `>=`), so a bridge row that
 * ties a session's recency never displaces it — the existing (unbridged)
 * behavior wins every tie, exactly as it did before bridges existed. A
 * binding that is itself bridged has, by §7.2, no session-loop candidate to
 * tie against in the first place — the two passes source disjoint bindings
 * in practice, not just by tie-break rule.
 *
 * @param bindings - The agent's eligible (non-paused, channel-filtered) bindings.
 * @param bindingRouter - Session lookup.
 * @param bridgeStore - Live-bridge lookup; omitted deps behave as if no
 *   binding is ever bridged (pre-§7.5 behavior).
 * @returns The best binding/chat pair, or `null` when none is addressable.
 */
function pickMostRecentChat(
  bindings: AdapterBinding[],
  bindingRouter: NotifyTargetBindingRouter,
  bridgeStore?: NotifyTargetBridgeStore
): { binding: AdapterBinding; chatId: string; bridged: boolean } | null {
  let best: { binding: AdapterBinding; chatId: string; at: number; bridged: boolean } | null = null;

  for (const binding of bindings) {
    for (const session of bindingRouter.getSessionsByBinding(binding.id)) {
      const chatId = session.scope === 'chat' ? session.chatId : binding.chatId;
      if (!chatId) continue; // active person, unknown conversation — see above
      if (!best || session.lastActivityAt > best.at) {
        best = { binding, chatId, at: session.lastActivityAt, bridged: false };
      }
    }
  }

  if (bridgeStore) {
    const bindingById = new Map(bindings.map((b) => [b.id, b]));
    for (const bridge of bridgeStore.listLiveBridges()) {
      const binding = bindingById.get(bridge.bindingId);
      if (!binding) continue; // not one of this agent's eligible bindings
      // The sole writer (`BridgeStore.stampActivity`) always writes a valid
      // ISO string, so this can't happen today — but that invariant lives in
      // a different file (deliver.ts) than this comparison, and `Date.parse`
      // returns NaN for a malformed value. Every `at > best.at` comparison
      // against NaN is false, which would freeze the scan on the bad
      // candidate and silently skip every genuinely more-recent one after
      // it — a worse failure than just treating it as "never active".
      const parsed = bridge.lastActivityAt ? Date.parse(bridge.lastActivityAt) : 0;
      const at = Number.isFinite(parsed) ? parsed : 0;
      if (!best || at > best.at) {
        best = { binding, chatId: bridge.chatId, at, bridged: true };
      }
    }
  }

  return best ? { binding: best.binding, chatId: best.chatId, bridged: best.bridged } : null;
}

/**
 * Resolve the integration an agent may initiate a proactive message on.
 *
 * @param agentId - The agent whose own integration bindings are searched.
 * @param deps - Binding/session/adapter lookups plus an optional channel filter.
 * @returns A structured target on success, or a structured non-delivery reason.
 */
export function resolveNotifyTarget(agentId: string, deps: NotifyTargetDeps): NotifyTarget {
  const { bindingStore, bindingRouter, adapterManager, bridgeStore, channel } = deps;

  const allBindings = bindingStore.getAll();
  // Paused bindings (enabled === false) are excluded up front: the schema
  // documents `enabled` as skipping both inbound delivery and agent-initiated
  // publishes, and the client UI promises "Paused — no messages routing".
  let myBindings = allBindings.filter((b) => b.agentId === agentId && b.enabled !== false);

  if (channel) {
    const ch = channel.toLowerCase();

    // Tier 1: exact adapter ID match
    const exactIdMatches = myBindings.filter((b) => b.adapterId.toLowerCase() === ch);
    if (exactIdMatches.length > 0) {
      myBindings = exactIdMatches;
    } else if (adapterManager) {
      // Tier 2: exact adapter type match (e.g., "telegram" matches all telegram adapters)
      const adapters = adapterManager.listAdapters();
      const typeMatchIds = new Set(
        adapters.filter((a) => a.config.type.toLowerCase() === ch).map((a) => a.config.id)
      );
      const typeMatches = myBindings.filter((b) => typeMatchIds.has(b.adapterId));
      // Tier 3: substring ID match (fallback for partial IDs like "tele")
      myBindings =
        typeMatches.length > 0
          ? typeMatches
          : myBindings.filter((b) => b.adapterId.toLowerCase().includes(ch));
    } else {
      // No adapterManager — fall back to substring match
      myBindings = myBindings.filter((b) => b.adapterId.toLowerCase().includes(ch));
    }
  }

  if (myBindings.length === 0) {
    const available = allBindings.filter((b) => b.agentId === agentId).map((b) => b.adapterId);
    return { ok: false, reason: 'NO_BINDING', availableChannels: available };
  }

  const best = pickMostRecentChat(myBindings, bindingRouter, bridgeStore);

  if (!best) {
    return {
      ok: false,
      reason: 'NO_ACTIVE_SESSIONS',
      availableAdapters: myBindings.map((b) => b.adapterId),
    };
  }

  // A proactive notification always INITIATES. The resolved binding must be
  // enabled and consent to agent-initiated messages (DOR-239) — evaluated
  // through the same shared predicate the delivery-layer gate uses (DOR-277),
  // so there is one consent decision. Reply routing is a separate, automatic
  // path (the `agent:` principal) that neither this resolver nor the gate
  // touches.
  if (!bindingAllowsInitiate(best.binding)) {
    return {
      ok: false,
      reason: 'INITIATE_NOT_ALLOWED',
      bindingId: best.binding.id,
      adapterId: best.binding.adapterId,
    };
  }

  const adapters = adapterManager?.listAdapters() ?? [];
  const adapter = adapters.find((a) => a.config.id === best.binding.adapterId);
  const adapterType = adapter?.config?.type ?? 'unknown';
  const subject = `relay.human.${adapterType}.${best.binding.adapterId}.${best.chatId}`;

  return {
    ok: true,
    subject,
    adapterId: best.binding.adapterId,
    adapterType,
    chatId: best.chatId,
    bindingId: best.binding.id,
    notifyOnTaskComplete: best.binding.notifyOnTaskComplete,
    bridged: best.bridged,
  };
}
