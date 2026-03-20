/**
 * Queue management for the Claude Code adapter.
 *
 * Manages per-agent message queues with promise-chain serialization.
 * Ensures agents process messages sequentially while allowing
 * parallel processing across different agents.
 *
 * @module relay/adapters/claude-code-queue
 */

import type { DeliveryResult } from '../../types.js';

/**
 * Per-agent serial queue that prevents concurrent SDK transport connections.
 *
 * Each agent ID gets its own promise chain. Messages to the same agent are
 * serialized (preventing the SDK "Already connected to a transport" error),
 * while messages to different agents run in parallel.
 */
export class AgentQueue {
  /** Per-agentId promise chain for serializing concurrent messages to the same agent. */
  private readonly queues = new Map<string, Promise<void>>();

  /**
   * Process a delivery function through a per-agent serial queue.
   *
   * Prevents the SDK "Already connected to a transport" error by ensuring
   * only one sendMessage() call runs per agentId at a time. Cross-agent
   * messages run in parallel (separate queue entries).
   *
   * @param agentId - The Mesh ULID identifying the target agent (used as the queue key)
   * @param fn - Async function that performs the actual delivery
   */
  async process(agentId: string, fn: () => Promise<DeliveryResult>): Promise<DeliveryResult> {
    const current = this.queues.get(agentId) ?? Promise.resolve();
    let result!: DeliveryResult;
    const next = current.then(() =>
      fn().then((r) => {
        result = r;
      })
    );
    // Store the chain but swallow errors to prevent unhandled rejection
    // on the queue reference itself (errors are returned via result)
    this.queues.set(
      agentId,
      next.catch(() => {})
    );
    await next;
    return result;
  }

  /** Number of agents with active queue entries. */
  get size(): number {
    return this.queues.size;
  }

  /** Clear all queues (used on adapter stop). */
  clear(): void {
    this.queues.clear();
  }
}
