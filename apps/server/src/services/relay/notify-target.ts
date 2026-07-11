/**
 * Shared channel-resolution for proactive, agent-initiated messages.
 *
 * Resolves the best bound channel an agent may INITIATE a message on: filter the
 * agent's non-paused bindings (optionally by channel), pick the most-recently
 * active chat session, enforce the `canInitiate` consent gate (DOR-239), and
 * build the `relay.human.*` publish subject. Both the `relay_notify_user` MCP
 * tool and the system-level {@link TaskCompletionNotifier} (DOR-240) resolve
 * through this one function so the two paths honor identical binding, session,
 * and consent rules.
 *
 * @module services/relay/notify-target
 */
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';

/** Minimal binding-store surface the resolver reads. */
export interface NotifyTargetBindingStore {
  getAll(): AdapterBinding[];
}

/** Minimal binding-router surface — active chat sessions for a binding. */
export interface NotifyTargetBindingRouter {
  getSessionsByBinding(bindingId: string): Array<{ chatId: string; sessionId: string }>;
}

/** Minimal adapter-manager surface — resolves an adapter id to its type. */
export interface NotifyTargetAdapterManager {
  listAdapters(): Array<{ config: { id: string; type: string } }>;
}

/** Dependencies for {@link resolveNotifyTarget}. */
export interface NotifyTargetDeps {
  bindingStore: NotifyTargetBindingStore;
  bindingRouter: NotifyTargetBindingRouter;
  /** Optional — used for channel-by-type filtering and adapter-type lookup. */
  adapterManager?: NotifyTargetAdapterManager;
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
      /** The resolved binding's per-channel task-completion opt-in (DOR-240). */
      notifyOnTaskComplete: boolean;
    }
  | { ok: false; reason: 'NO_BINDING'; availableChannels: string[] }
  | { ok: false; reason: 'NO_ACTIVE_SESSIONS'; availableAdapters: string[] }
  | { ok: false; reason: 'INITIATE_NOT_ALLOWED'; bindingId: string; adapterId: string };

/**
 * Resolve the channel an agent may initiate a proactive message on.
 *
 * @param agentId - The agent whose own channel bindings are searched.
 * @param deps - Binding/session/adapter lookups plus an optional channel filter.
 * @returns A structured target on success, or a structured non-delivery reason.
 */
export function resolveNotifyTarget(agentId: string, deps: NotifyTargetDeps): NotifyTarget {
  const { bindingStore, bindingRouter, adapterManager, channel } = deps;

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

  let best: {
    bindingId: string;
    chatId: string;
    adapterId: string;
    canInitiate: boolean;
    notifyOnTaskComplete: boolean;
  } | null = null;
  for (const binding of myBindings) {
    const sessions = bindingRouter.getSessionsByBinding(binding.id);
    if (sessions.length > 0) {
      const latest = sessions[sessions.length - 1]!;
      best = {
        chatId: latest.chatId,
        bindingId: binding.id,
        adapterId: binding.adapterId,
        canInitiate: binding.canInitiate,
        notifyOnTaskComplete: binding.notifyOnTaskComplete,
      };
    }
  }

  if (!best) {
    return {
      ok: false,
      reason: 'NO_ACTIVE_SESSIONS',
      availableAdapters: myBindings.map((b) => b.adapterId),
    };
  }

  // A proactive notification always INITIATES — a false canInitiate on the
  // resolved binding unconditionally blocks it (DOR-239). Reply routing is a
  // separate, automatic path that this gate never touches.
  if (!best.canInitiate) {
    return {
      ok: false,
      reason: 'INITIATE_NOT_ALLOWED',
      bindingId: best.bindingId,
      adapterId: best.adapterId,
    };
  }

  const adapters = adapterManager?.listAdapters() ?? [];
  const adapter = adapters.find((a) => a.config.id === best!.adapterId);
  const adapterType = adapter?.config?.type ?? 'unknown';
  const subject = `relay.human.${adapterType}.${best.adapterId}.${best.chatId}`;

  return {
    ok: true,
    subject,
    adapterId: best.adapterId,
    adapterType,
    chatId: best.chatId,
    bindingId: best.bindingId,
    notifyOnTaskComplete: best.notifyOnTaskComplete,
  };
}
