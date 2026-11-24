import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SubscriptionRegistry } from '../subscription-registry.js';
import type { MessageHandler } from '../types.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let registry: SubscriptionRegistry;

/** Create a minimal RelayEnvelope for testing. */
function makeEnvelope(subject: string): RelayEnvelope {
  return {
    id: '01TEST000000000000000000000',
    subject,
    from: 'test.sender',
    budget: {
      hopCount: 0,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 60_000,
      callBudgetRemaining: 10,
    },
    createdAt: new Date().toISOString(),
    payload: { content: 'hello' },
  };
}

beforeEach(() => {
  registry = new SubscriptionRegistry();
});

afterEach(() => {
  registry.shutdown();
});

// ---------------------------------------------------------------------------
// subscribe + getSubscribers
// ---------------------------------------------------------------------------

describe('SubscriptionRegistry', () => {
  describe('subscribe', () => {
    it('stores handler and returns unsubscribe function', () => {
      const handler: MessageHandler = vi.fn();
      const unsub = registry.subscribe('relay.agent.test', handler);

      expect(typeof unsub).toBe('function');
      expect(registry.size).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // getSubscribers
  // ---------------------------------------------------------------------------

  describe('getSubscribers', () => {
    it('returns matching handlers for exact subject', () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.test', handler);

      const subscribers = registry.getSubscribers('relay.agent.test');
      expect(subscribers).toHaveLength(1);
      expect(subscribers[0]).toBe(handler);
    });

    it('matches single wildcard pattern (*)', () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.*', handler);

      const subscribers = registry.getSubscribers('relay.agent.backend');
      expect(subscribers).toHaveLength(1);
      expect(subscribers[0]).toBe(handler);
    });

    it('matches multi-wildcard pattern (>)', () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.>', handler);

      const match1 = registry.getSubscribers('relay.agent');
      expect(match1).toHaveLength(1);

      const match2 = registry.getSubscribers('relay.agent.backend.logs');
      expect(match2).toHaveLength(1);
    });

    it('returns multiple handlers when multiple subscriptions match', () => {
      const handler1: MessageHandler = vi.fn();
      const handler2: MessageHandler = vi.fn();
      const handler3: MessageHandler = vi.fn();

      registry.subscribe('relay.agent.test', handler1);
      registry.subscribe('relay.agent.*', handler2);
      registry.subscribe('relay.>', handler3);

      const subscribers = registry.getSubscribers('relay.agent.test');
      expect(subscribers).toHaveLength(3);
      expect(subscribers).toContain(handler1);
      expect(subscribers).toContain(handler2);
      expect(subscribers).toContain(handler3);
    });
  });

  // ---------------------------------------------------------------------------
  // Unsubscribe
  // ---------------------------------------------------------------------------

  describe('unsubscribe', () => {
    it('removes handler from getSubscribers results', () => {
      const handler: MessageHandler = vi.fn();
      const unsub = registry.subscribe('relay.agent.test', handler);

      unsub();

      const subscribers = registry.getSubscribers('relay.agent.test');
      expect(subscribers).toHaveLength(0);
    });

    it('removes all matching handlers after clear', () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.test', handler);

      registry.clear();

      const subscribers = registry.getSubscribers('relay.agent.test');
      expect(subscribers).toHaveLength(0);
    });

    it('only removes the specific subscription, not others with same pattern', () => {
      const handler1: MessageHandler = vi.fn();
      const handler2: MessageHandler = vi.fn();

      const unsub1 = registry.subscribe('relay.agent.test', handler1);
      registry.subscribe('relay.agent.test', handler2);

      unsub1();

      const subscribers = registry.getSubscribers('relay.agent.test');
      expect(subscribers).toHaveLength(1);
      expect(subscribers[0]).toBe(handler2);
    });
  });

  // ---------------------------------------------------------------------------
  // listSubscriptions
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Restart behavior — regression for C1 (persisted noop subscriptions)
  // ---------------------------------------------------------------------------

  describe('restart behavior', () => {
    it('a fresh registry starts empty — no patterns survive a restart as phantom subscribers', () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.alpha', handler);
      registry.subscribe('relay.system.>', handler);

      // Simulate a process restart: a new registry instance.
      const registry2 = new SubscriptionRegistry();

      // Handlers cannot be persisted, so no subscription may be restored —
      // a restored pattern with a noop handler would claim and destroy
      // messages that have no real consumer.
      expect(registry2.size).toBe(0);
      expect(registry2.listSubscriptions()).toEqual([]);
      expect(registry2.getSubscribers('relay.agent.alpha')).toHaveLength(0);

      registry2.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // clear
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Pending buffer (task 2.1: bufferForPendingSubscriber)
  // ---------------------------------------------------------------------------

  describe('pending buffer', () => {
    it('subscriber receives messages published after registration', async () => {
      // This tests the existing pub/sub behavior: messages are only delivered
      // to subscribers that exist at publish time. This is the baseline that
      // the pending buffer (task 2.1) extends.
      const received: RelayEnvelope[] = [];
      const handler: MessageHandler = async (envelope) => {
        received.push(envelope);
      };

      registry.subscribe('relay.human.console.abc', handler);

      // Simulate what getSubscribers + handler invocation looks like
      const envelope = makeEnvelope('relay.human.console.abc');
      const subscribers = registry.getSubscribers('relay.human.console.abc');
      for (const sub of subscribers) {
        await sub(envelope);
      }

      expect(received).toHaveLength(1);
      expect(received[0].id).toBe(envelope.id);
    });

    it('drains buffered messages in order when subscriber registers', async () => {
      const envelope1 = makeEnvelope('relay.human.console.abc');
      const envelope2 = makeEnvelope('relay.human.console.abc');

      registry.bufferForPendingSubscriber('relay.human.console.abc', envelope1);
      registry.bufferForPendingSubscriber('relay.human.console.abc', envelope2);

      const received: RelayEnvelope[] = [];
      registry.subscribe('relay.human.console.abc', async (env) => {
        received.push(env);
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(received).toHaveLength(2);
      expect(received[0].id).toBe(envelope1.id);
      expect(received[1].id).toBe(envelope2.id);
    });

    it('does not deliver messages after cleanup timer evicts them', async () => {
      vi.useFakeTimers();

      // Create registry with fake timers so setInterval is controlled
      const timedRegistry = new SubscriptionRegistry();

      const envelope = makeEnvelope('relay.human.console.abc');
      timedRegistry.bufferForPendingSubscriber('relay.human.console.abc', envelope);

      // Advance past TTL so cleanup timer fires and evicts the message.
      // Cleanup fires at 30s intervals; at 60s the message (buffered at t=0) is stale.
      await vi.advanceTimersByTimeAsync(60_001);

      const received: RelayEnvelope[] = [];
      timedRegistry.subscribe('relay.human.console.abc', async (env) => {
        received.push(env);
      });

      await vi.advanceTimersByTimeAsync(10);

      expect(received).toHaveLength(0);

      timedRegistry.shutdown();
      vi.useRealTimers();
    });
  });

  // ---------------------------------------------------------------------------
  // size
  // ---------------------------------------------------------------------------
});
