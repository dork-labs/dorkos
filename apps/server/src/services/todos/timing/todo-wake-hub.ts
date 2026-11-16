/**
 * Who hears a to-do's wakes (spec `heartbeats` §12). The heartbeat runner subscribes after boot,
 * so a wake that fires while nobody listens (startup finds promises already due) is held and
 * handed to the FIRST observer. A held wake lost to a restart is not repeated, because the row
 * already records it; the missed mark still lands after the grace.
 *
 * @module services/todos/timing/todo-wake-hub
 */
import { logger } from '../../../lib/logger.js';
import type { TodoPromiseDueEvent, TodoPromiseObserver } from '../todo-promise-types.js';

/** The most wakes held for a first observer; older ones are dropped beyond it. */
const PENDING_WAKES_MAX = 500;

/** Hands wakes to observers, holding them until the first one listens. */
export class TodoWakeHub {
  private readonly observers = new Set<TodoPromiseObserver>();
  private readonly pending: TodoPromiseDueEvent[] = [];

  /**
   * Listen for wakes. The first observer also receives every wake held so far.
   *
   * @param fn - Called with each `commitment.due` event.
   * @returns A function that stops listening.
   */
  observe(fn: TodoPromiseObserver): () => void {
    this.observers.add(fn);
    for (const event of this.pending.splice(0)) this.deliver(event);
    return () => {
      this.observers.delete(fn);
    };
  }

  /**
   * Hand one wake to every observer, or hold it while nobody listens.
   *
   * @param event - The wake.
   */
  emit(event: TodoPromiseDueEvent): void {
    if (this.observers.size === 0) {
      this.pending.push(event);
      if (this.pending.length > PENDING_WAKES_MAX) this.pending.shift();
      return;
    }
    this.deliver(event);
  }

  /** One wake to every observer; one that throws never stops the rest. */
  private deliver(event: TodoPromiseDueEvent): void {
    for (const observer of this.observers) {
      try {
        observer(event);
      } catch (err) {
        logger.warn('[to-dos] a commitment.due observer threw', {
          id: event.todoPromise.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
