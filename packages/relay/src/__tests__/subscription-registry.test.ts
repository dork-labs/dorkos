import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SubscriptionRegistry } from '../subscription-registry.js';
import type { MessageHandler } from '../types.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
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

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'relay-sub-test-'));
  registry = new SubscriptionRegistry(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
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

    it('throws when pattern is invalid', () => {
      const handler: MessageHandler = vi.fn();

      expect(() => registry.subscribe('', handler)).toThrow('Invalid subscription pattern');
      expect(() => registry.subscribe('relay..bad', handler)).toThrow(
        'Invalid subscription pattern',
      );
    });

    it('allows wildcard patterns', () => {
      const handler: MessageHandler = vi.fn();

      expect(() => registry.subscribe('relay.agent.*', handler)).not.toThrow();
      expect(() => registry.subscribe('relay.>', handler)).not.toThrow();
      expect(registry.size).toBe(2);
    });

    it('allows multiple subscriptions to the same pattern', () => {
      const handler1: MessageHandler = vi.fn();
      const handler2: MessageHandler = vi.fn();

      registry.subscribe('relay.agent.test', handler1);
      registry.subscribe('relay.agent.test', handler2);

      expect(registry.size).toBe(2);
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

    it('returns empty array when no subscriptions match', () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.alpha', handler);

      const subscribers = registry.getSubscribers('relay.agent.beta');
      expect(subscribers).toHaveLength(0);
    });

    it('matches single wildcard pattern (*)', () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.*', handler);

      const subscribers = registry.getSubscribers('relay.agent.backend');
      expect(subscribers).toHaveLength(1);
      expect(subscribers[0]).toBe(handler);
    });

    it('single wildcard does not match multiple tokens', () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.*', handler);

      const subscribers = registry.getSubscribers('relay.agent.backend.extra');
      expect(subscribers).toHaveLength(0);
    });

    it('matches multi-wildcard pattern (>)', () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.>', handler);

      const match1 = registry.getSubscribers('relay.agent');
      expect(match1).toHaveLength(1);

      const match2 = registry.getSubscribers('relay.agent.backend.logs');
      expect(match2).toHaveLength(1);
    });

    it('multi-wildcard requires at least one token', () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.>', handler);

      // relay.agent alone should NOT match relay.agent.> (> requires 1+ tokens)
      const subscribers = registry.getSubscribers('relay.agent');
      expect(subscribers).toHaveLength(0);
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

    it('does not return non-matching handlers', () => {
      const matchingHandler: MessageHandler = vi.fn();
      const nonMatchingHandler: MessageHandler = vi.fn();

      registry.subscribe('relay.agent.*', matchingHandler);
      registry.subscribe('relay.system.*', nonMatchingHandler);

      const subscribers = registry.getSubscribers('relay.agent.backend');
      expect(subscribers).toHaveLength(1);
      expect(subscribers[0]).toBe(matchingHandler);
    });

    it('handlers can be invoked with an envelope', async () => {
      const received: RelayEnvelope[] = [];
      const handler: MessageHandler = (envelope) => {
        received.push(envelope);
      };

      registry.subscribe('relay.agent.test', handler);

      const subscribers = registry.getSubscribers('relay.agent.test');
      const envelope = makeEnvelope('relay.agent.test');

      for (const sub of subscribers) {
        await sub(envelope);
      }

      expect(received).toHaveLength(1);
      expect(received[0]).toBe(envelope);
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

    it('decrements subscription count', () => {
      const handler: MessageHandler = vi.fn();
      const unsub = registry.subscribe('relay.agent.test', handler);
      expect(registry.size).toBe(1);

      unsub();
      expect(registry.size).toBe(0);
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

    it('is safe to call multiple times', () => {
      const handler: MessageHandler = vi.fn();
      const unsub = registry.subscribe('relay.agent.test', handler);

      unsub();
      unsub(); // Second call should be harmless

      expect(registry.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // listSubscriptions
  // ---------------------------------------------------------------------------

  describe('listSubscriptions', () => {
    it('returns empty array when no subscriptions exist', () => {
      expect(registry.listSubscriptions()).toEqual([]);
    });

    it('returns all active subscriptions with correct info', () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.alpha', handler);
      registry.subscribe('relay.system.>', handler);

      const subs = registry.listSubscriptions();
      expect(subs).toHaveLength(2);

      const patterns = subs.map((s) => s.pattern).sort();
      expect(patterns).toEqual(['relay.agent.alpha', 'relay.system.>']);

      // Each subscription should have a valid id and createdAt
      for (const sub of subs) {
        expect(sub.id).toBeTruthy();
        expect(sub.createdAt).toBeTruthy();
        expect(new Date(sub.createdAt).toISOString()).toBe(sub.createdAt);
      }
    });

    it('does not include unsubscribed entries', () => {
      const handler: MessageHandler = vi.fn();
      const unsub = registry.subscribe('relay.agent.alpha', handler);
      registry.subscribe('relay.system.beta', handler);

      unsub();

      const subs = registry.listSubscriptions();
      expect(subs).toHaveLength(1);
      expect(subs[0].pattern).toBe('relay.system.beta');
    });
  });

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  describe('persistence', () => {
    it('writes subscriptions.json on subscribe', async () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.test', handler);

      const filePath = join(tempDir, 'subscriptions.json');
      expect(existsSync(filePath)).toBe(true);

      const raw = await readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);

      expect(data).toHaveLength(1);
      expect(data[0].pattern).toBe('relay.agent.test');
      expect(data[0].id).toBeTruthy();
      expect(data[0].createdAt).toBeTruthy();
    });

    it('updates subscriptions.json on unsubscribe', async () => {
      const handler: MessageHandler = vi.fn();
      const unsub1 = registry.subscribe('relay.agent.alpha', handler);
      registry.subscribe('relay.agent.beta', handler);

      unsub1();

      const filePath = join(tempDir, 'subscriptions.json');
      const raw = await readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);

      expect(data).toHaveLength(1);
      expect(data[0].pattern).toBe('relay.agent.beta');
    });

    it('persists multiple subscriptions', async () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.*', handler);
      registry.subscribe('relay.system.>', handler);
      registry.subscribe('relay.agent.specific', handler);

      const filePath = join(tempDir, 'subscriptions.json');
      const raw = await readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);

      expect(data).toHaveLength(3);
      const patterns = data.map((d: { pattern: string }) => d.pattern).sort();
      expect(patterns).toEqual(['relay.agent.*', 'relay.agent.specific', 'relay.system.>']);
    });
  });

  // ---------------------------------------------------------------------------
  // Restart recovery
  // ---------------------------------------------------------------------------

  describe('restart recovery', () => {
    it('restores subscription patterns from subscriptions.json', () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.alpha', handler);
      registry.subscribe('relay.system.>', handler);

      // Create a new registry instance from the same data directory
      const registry2 = new SubscriptionRegistry(tempDir);

      const subs = registry2.listSubscriptions();
      expect(subs).toHaveLength(2);

      const patterns = subs.map((s) => s.pattern).sort();
      expect(patterns).toEqual(['relay.agent.alpha', 'relay.system.>']);
    });

    it('restored subscriptions have noop handlers (not the original ones)', () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.test', handler);

      const registry2 = new SubscriptionRegistry(tempDir);

      // The restored subscription should have a noop handler, not the original
      const subscribers = registry2.getSubscribers('relay.agent.test');
      expect(subscribers).toHaveLength(1);
      expect(subscribers[0]).not.toBe(handler);
    });

    it('preserves subscription IDs across restart', () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.test', handler);

      const originalSubs = registry.listSubscriptions();
      const originalId = originalSubs[0].id;

      const registry2 = new SubscriptionRegistry(tempDir);
      const restoredSubs = registry2.listSubscriptions();

      expect(restoredSubs[0].id).toBe(originalId);
    });

    it('handles missing subscriptions.json gracefully', () => {
      // tempDir has no subscriptions.json — constructor should not throw
      const freshRegistry = new SubscriptionRegistry(join(tempDir, 'nonexistent'));
      expect(freshRegistry.size).toBe(0);
    });

    it('handles corrupted subscriptions.json gracefully', async () => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(tempDir, 'subscriptions.json'), 'not valid json', 'utf-8');

      // Should not throw
      const freshRegistry = new SubscriptionRegistry(tempDir);
      expect(freshRegistry.size).toBe(0);
    });

    it('handles subscriptions.json with invalid entries gracefully', async () => {
      const { writeFileSync } = await import('node:fs');
      const invalidData = [
        { id: 'valid-id', pattern: 'relay.agent.test', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 123, pattern: 'relay.agent.bad', createdAt: '2026-01-01T00:00:00.000Z' }, // id is number
        { pattern: 'relay.agent.noid', createdAt: '2026-01-01T00:00:00.000Z' }, // missing id
      ];
      writeFileSync(join(tempDir, 'subscriptions.json'), JSON.stringify(invalidData), 'utf-8');

      const freshRegistry = new SubscriptionRegistry(tempDir);
      // Only the first entry with all valid string fields should be loaded
      expect(freshRegistry.size).toBe(1);
      expect(freshRegistry.listSubscriptions()[0].pattern).toBe('relay.agent.test');
    });

    it('handles subscriptions.json that is not an array gracefully', async () => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        join(tempDir, 'subscriptions.json'),
        JSON.stringify({ not: 'an array' }),
        'utf-8',
      );

      const freshRegistry = new SubscriptionRegistry(tempDir);
      expect(freshRegistry.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // clear
  // ---------------------------------------------------------------------------

  describe('clear', () => {
    it('removes all subscriptions', () => {
      const handler1: MessageHandler = vi.fn();
      const handler2: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.alpha', handler1);
      registry.subscribe('relay.system.>', handler2);
      expect(registry.size).toBe(2);

      registry.clear();
      expect(registry.size).toBe(0);
      expect(registry.listSubscriptions()).toEqual([]);
    });

    it('removes all matching handlers after clear', () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.test', handler);

      registry.clear();

      const subscribers = registry.getSubscribers('relay.agent.test');
      expect(subscribers).toHaveLength(0);
    });

    it('persists empty state to disk', () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.alpha', handler);
      registry.subscribe('relay.system.>', handler);

      registry.clear();

      // Create a new registry from the same directory — should have 0 subscriptions
      const registry2 = new SubscriptionRegistry(tempDir);
      expect(registry2.size).toBe(0);
      expect(registry2.listSubscriptions()).toEqual([]);
    });

    it('is safe to call when already empty', () => {
      expect(registry.size).toBe(0);
      registry.clear();
      expect(registry.size).toBe(0);
    });

    it('allows new subscriptions after clear', () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.alpha', handler);
      registry.clear();

      registry.subscribe('relay.agent.beta', handler);
      expect(registry.size).toBe(1);
      expect(registry.listSubscriptions()[0].pattern).toBe('relay.agent.beta');
    });
  });

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

    it('messages published before subscriber registration are lost without pending buffer', async () => {
      // Demonstrates the gap that bufferForPendingSubscriber (task 2.1) addresses.
      // Without the buffer, messages published before subscribe() are dropped.
      const _envelope = makeEnvelope('relay.human.console.abc');

      // Publish BEFORE any subscriber exists
      const subscribersBefore = registry.getSubscribers('relay.human.console.abc');
      expect(subscribersBefore).toHaveLength(0);

      // Now subscribe
      const received: RelayEnvelope[] = [];
      registry.subscribe('relay.human.console.abc', async (env) => {
        received.push(env);
      });

      // The envelope was already published — the subscriber won't see it
      // (unless bufferForPendingSubscriber is implemented)
      expect(received).toHaveLength(0);
    });

    it('buffers messages when no subscriber exists', async () => {
      const envelope = makeEnvelope('relay.human.console.abc');
      registry.bufferForPendingSubscriber('relay.human.console.abc', envelope);

      const received: RelayEnvelope[] = [];
      registry.subscribe('relay.human.console.abc', async (env) => {
        received.push(env);
      });

      // Wait for microtask drain
      await new Promise((resolve) => setTimeout(resolve, 10));

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
      const timedRegistry = new SubscriptionRegistry(tempDir);

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

    it('cleanup timer removes stale entries from pendingBuffers map', async () => {
      vi.useFakeTimers();

      const timedRegistry = new SubscriptionRegistry(tempDir);

      const envelope = makeEnvelope('relay.human.console.abc');
      timedRegistry.bufferForPendingSubscriber('relay.human.console.abc', envelope);

      // Advance past TTL + cleanup interval
      await vi.advanceTimersByTimeAsync(61_000);

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

  describe('size', () => {
    it('is 0 initially', () => {
      expect(registry.size).toBe(0);
    });

    it('increments on subscribe', () => {
      const handler: MessageHandler = vi.fn();
      registry.subscribe('relay.agent.a', handler);
      expect(registry.size).toBe(1);

      registry.subscribe('relay.agent.b', handler);
      expect(registry.size).toBe(2);
    });

    it('decrements on unsubscribe', () => {
      const handler: MessageHandler = vi.fn();
      const unsub = registry.subscribe('relay.agent.a', handler);
      registry.subscribe('relay.agent.b', handler);

      unsub();
      expect(registry.size).toBe(1);
    });
  });
});
