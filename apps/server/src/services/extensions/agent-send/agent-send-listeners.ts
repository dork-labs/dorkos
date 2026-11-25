/**
 * Who hears a mini app's delivery events (`ctx.agent.subscribe`, DOR-2683):
 * each extension's listeners, and the events kept for an extension nobody is
 * listening for yet, delivered to its first listener (bounded).
 *
 * @module services/extensions/agent-send/agent-send-listeners
 */
import type { AgentDeliveryEvent } from '@dorkos/extension-api/server';
import { logError, logger } from '../../../lib/logger.js';

/** How many delivery events are kept for an extension nobody is listening for. */
export const UNHEARD_EVENTS_MAX = 200;

/** Each extension's listeners, and what it has not heard yet. */
export class DeliveryListeners {
  private readonly listeners = new Map<string, Set<(event: AgentDeliveryEvent) => void>>();
  private readonly unheard = new Map<string, AgentDeliveryEvent[]>();

  /**
   * Hear what happens to an extension's messages. Events kept while nobody
   * listened are delivered to this listener first.
   *
   * @param extensionId - The extension.
   * @param listener - Receives each delivery event.
   * @returns A function that stops listening.
   */
  subscribe(extensionId: string, listener: (event: AgentDeliveryEvent) => void): () => void {
    let set = this.listeners.get(extensionId);
    if (!set) this.listeners.set(extensionId, (set = new Set()));
    set.add(listener);
    const backlog = this.unheard.get(extensionId);
    if (backlog) {
      this.unheard.delete(extensionId);
      for (const event of backlog) this.call(extensionId, listener, event);
    }
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(extensionId) === set)
        this.listeners.delete(extensionId);
    };
  }

  /**
   * Hand an event to the extension's listeners, or keep it for the first one.
   *
   * @param extensionId - The extension.
   * @param event - The delivery event.
   */
  deliver(extensionId: string, event: AgentDeliveryEvent): void {
    const set = this.listeners.get(extensionId);
    if (set && set.size > 0) {
      for (const listener of [...set]) this.call(extensionId, listener, event);
      return;
    }
    const backlog = this.unheard.get(extensionId) ?? [];
    backlog.push(event);
    // Bounded: an extension that never listens must not grow this forever.
    if (backlog.length > UNHEARD_EVENTS_MAX) backlog.splice(0, backlog.length - UNHEARD_EVENTS_MAX);
    this.unheard.set(extensionId, backlog);
  }

  /** Call one listener, so a throwing extension cannot break delivery or the dispatcher. */
  private call(
    extensionId: string,
    listener: (event: AgentDeliveryEvent) => void,
    event: AgentDeliveryEvent
  ): void {
    try {
      listener(event);
    } catch (err) {
      logger.warn(`[ext:${extensionId}] an agent delivery listener threw`, logError(err));
    }
  }
}
