import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RelayCore } from '../relay-core.js';
import { MaildirStore } from '../maildir-store.js';
import { SqliteIndex } from '../sqlite-index.js';
import type { RelayEnvelope, Signal } from '@dorkos/shared/relay-schemas';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let relay: RelayCore;

/**
 * Create a fresh RelayCore with a temp data directory.
 * Each test gets a clean filesystem to avoid cross-test contamination.
 */
function createRelay(
  options?: Partial<{ maxHops: number; defaultTtlMs: number; defaultCallBudget: number }>,
): RelayCore {
  return new RelayCore({
    dataDir: tmpDir,
    maxHops: options?.maxHops ?? 5,
    defaultTtlMs: options?.defaultTtlMs ?? 3_600_000,
    defaultCallBudget: options?.defaultCallBudget ?? 10,
  });
}

/**
 * Wait for a specified number of milliseconds.
 * Used for access control hot-reload timing.
 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-core-test-'));
  relay = createRelay();
});

afterEach(async () => {
  await relay.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Constructor and lifecycle
// ---------------------------------------------------------------------------

describe('constructor and lifecycle', () => {
  it('creates a RelayCore instance with default options', () => {
    expect(relay).toBeInstanceOf(RelayCore);
  });

  it('close() is idempotent — safe to call multiple times', async () => {
    await relay.close();
    await relay.close(); // Should not throw
  });

  it('throws after close for publish', async () => {
    await relay.close();
    await expect(
      relay.publish('relay.test', { data: true }, { from: 'relay.sender' }),
    ).rejects.toThrow('RelayCore has been closed');
  });

  it('throws after close for subscribe', async () => {
    await relay.close();
    expect(() => relay.subscribe('relay.test', () => {})).toThrow('RelayCore has been closed');
  });

  it('throws after close for registerEndpoint', async () => {
    await relay.close();
    await expect(relay.registerEndpoint('relay.test')).rejects.toThrow(
      'RelayCore has been closed',
    );
  });
});

// ---------------------------------------------------------------------------
// Endpoint registration
// ---------------------------------------------------------------------------

describe('endpoint registration', () => {
  it('registers an endpoint and returns EndpointInfo', async () => {
    const info = await relay.registerEndpoint('relay.agent.backend');

    expect(info.subject).toBe('relay.agent.backend');
    expect(info.hash).toBeDefined();
    expect(info.hash.length).toBe(12);
    expect(info.maildirPath).toContain('mailboxes');
    expect(info.registeredAt).toBeDefined();
  });

  it('creates Maildir directory structure on registration', async () => {
    const info = await relay.registerEndpoint('relay.agent.frontend');

    for (const subdir of ['tmp', 'new', 'cur', 'failed']) {
      const stat = await fs.stat(path.join(info.maildirPath, subdir));
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it('unregisters an endpoint', async () => {
    await relay.registerEndpoint('relay.agent.worker');
    const removed = await relay.unregisterEndpoint('relay.agent.worker');
    expect(removed).toBe(true);
  });

  it('returns false when unregistering a non-existent endpoint', async () => {
    const removed = await relay.unregisterEndpoint('relay.nonexistent');
    expect(removed).toBe(false);
  });

  it('rejects duplicate endpoint registration', async () => {
    await relay.registerEndpoint('relay.agent.dup');
    await expect(relay.registerEndpoint('relay.agent.dup')).rejects.toThrow(
      'Endpoint already registered',
    );
  });

  it('rejects invalid subjects', async () => {
    await expect(relay.registerEndpoint('')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Publish - basic
// ---------------------------------------------------------------------------

describe('publish - basic', () => {
  it('publishes a message to a registered endpoint', async () => {
    await relay.registerEndpoint('relay.agent.proj.backend');

    const result = await relay.publish(
      'relay.agent.proj.backend',
      { msg: 'hello' },
      { from: 'relay.agent.proj.frontend' },
    );

    expect(result.messageId).toBeDefined();
    expect(result.deliveredTo).toBe(1);
  });

  it('returns deliveredTo=0 when no endpoints match', async () => {
    const result = await relay.publish(
      'relay.agent.unknown',
      { msg: 'hello' },
      { from: 'relay.sender' },
    );

    expect(result.deliveredTo).toBe(0);
  });

  it('rejects invalid subjects', async () => {
    await expect(
      relay.publish('', { msg: 'hello' }, { from: 'relay.sender' }),
    ).rejects.toThrow('Invalid subject');
  });

  it('message is indexed in SQLite after publish', async () => {
    await relay.registerEndpoint('relay.agent.indexed');

    await relay.publish(
      'relay.agent.indexed',
      { data: 'test' },
      { from: 'relay.sender' },
    );

    const metrics = relay.getMetrics();
    expect(metrics.totalMessages).toBeGreaterThanOrEqual(1);
  });

  it('assigns a ULID message ID', async () => {
    await relay.registerEndpoint('relay.agent.ulid');

    const result = await relay.publish(
      'relay.agent.ulid',
      { data: 1 },
      { from: 'relay.sender' },
    );

    // ULID is 26 characters
    expect(result.messageId.length).toBe(26);
  });

  it('includes replyTo in envelope when provided', async () => {
    const received: RelayEnvelope[] = [];
    await relay.registerEndpoint('relay.agent.reply');
    relay.subscribe('relay.agent.reply', (envelope) => {
      received.push(envelope);
    });

    await relay.publish(
      'relay.agent.reply',
      { data: 1 },
      { from: 'relay.sender', replyTo: 'relay.sender.reply' },
    );

    expect(received.length).toBe(1);
    expect(received[0].replyTo).toBe('relay.sender.reply');
  });
});

// ---------------------------------------------------------------------------
// Publish - fan-out to multiple endpoints
// ---------------------------------------------------------------------------

describe('publish - fan-out', () => {
  it('delivers to each matching endpoint independently', async () => {
    await relay.registerEndpoint('relay.agent.proj.backend');
    await relay.registerEndpoint('relay.agent.proj.frontend');
    // Non-matching endpoint
    await relay.registerEndpoint('relay.system.monitor');

    // Publish to exact subject — only the matching endpoint receives it
    const result1 = await relay.publish(
      'relay.agent.proj.backend',
      { msg: 'hello' },
      { from: 'relay.sender' },
    );
    expect(result1.deliveredTo).toBe(1);

    const result2 = await relay.publish(
      'relay.agent.proj.frontend',
      { msg: 'hello' },
      { from: 'relay.sender' },
    );
    expect(result2.deliveredTo).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Publish - budget enforcement
// ---------------------------------------------------------------------------

describe('publish - budget enforcement', () => {
  it('rejects messages with expired TTL to DLQ', async () => {
    const info = await relay.registerEndpoint('relay.agent.budget-ttl');

    const result = await relay.publish(
      'relay.agent.budget-ttl',
      { data: 'expired' },
      { from: 'relay.sender', budget: { ttl: Date.now() - 1000 } },
    );

    expect(result.deliveredTo).toBe(0);

    const deadLetters = await relay.getDeadLetters({ endpointHash: info.hash });
    expect(deadLetters.length).toBeGreaterThanOrEqual(1);
    expect(deadLetters.some((dl) => dl.reason.includes('expired'))).toBe(true);
  });

  it('rejects messages with exceeded hop count to DLQ', async () => {
    const info = await relay.registerEndpoint('relay.agent.budget-hops');

    const result = await relay.publish(
      'relay.agent.budget-hops',
      { data: 'too many hops' },
      { from: 'relay.sender', budget: { hopCount: 5, maxHops: 5 } },
    );

    expect(result.deliveredTo).toBe(0);

    const deadLetters = await relay.getDeadLetters({ endpointHash: info.hash });
    expect(deadLetters.length).toBeGreaterThanOrEqual(1);
    expect(deadLetters.some((dl) => dl.reason.includes('max hops'))).toBe(true);
  });

  it('rejects messages with exhausted call budget to DLQ', async () => {
    const info = await relay.registerEndpoint('relay.agent.budget-calls');

    const result = await relay.publish(
      'relay.agent.budget-calls',
      { data: 'no budget' },
      { from: 'relay.sender', budget: { callBudgetRemaining: 0 } },
    );

    expect(result.deliveredTo).toBe(0);

    const deadLetters = await relay.getDeadLetters({ endpointHash: info.hash });
    expect(deadLetters.length).toBeGreaterThanOrEqual(1);
    expect(deadLetters.some((dl) => dl.reason.includes('call budget'))).toBe(true);
  });

  it('detects cycles via ancestor chain', async () => {
    const info = await relay.registerEndpoint('relay.agent.budget-cycle');

    const result = await relay.publish(
      'relay.agent.budget-cycle',
      { data: 'cycle' },
      { from: 'relay.sender', budget: { ancestorChain: ['relay.agent.budget-cycle'] } },
    );

    expect(result.deliveredTo).toBe(0);

    const deadLetters = await relay.getDeadLetters({ endpointHash: info.hash });
    expect(deadLetters.length).toBeGreaterThanOrEqual(1);
    expect(deadLetters.some((dl) => dl.reason.includes('cycle'))).toBe(true);
  });

  it('uses custom budget options from constructor', async () => {
    await relay.close();

    relay = new RelayCore({
      dataDir: tmpDir,
      maxHops: 2,
      defaultCallBudget: 3,
    });

    const received: RelayEnvelope[] = [];
    await relay.registerEndpoint('relay.agent.custom-budget');
    relay.subscribe('relay.agent.custom-budget', (env) => { received.push(env); });

    await relay.publish(
      'relay.agent.custom-budget',
      { data: 1 },
      { from: 'relay.sender' },
    );

    expect(received.length).toBe(1);
    expect(received[0].budget.maxHops).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Publish - access control
// ---------------------------------------------------------------------------

describe('publish - access control', () => {
  it('blocks messages denied by access control rules', async () => {
    // Close the default relay instance
    await relay.close();

    // Write the deny rule directly to disk before constructing a new relay
    const rulesPath = path.join(tmpDir, 'access-rules.json');
    const rules = [
      {
        from: 'relay.attacker',
        to: 'relay.agent.protected',
        action: 'deny',
        priority: 100,
      },
    ];
    fsSync.writeFileSync(rulesPath, JSON.stringify(rules, null, 2));

    // Construct a new RelayCore that picks up the rules file at construction
    relay = new RelayCore({ dataDir: tmpDir });
    await relay.registerEndpoint('relay.agent.protected');

    await expect(
      relay.publish(
        'relay.agent.protected',
        { data: 'blocked' },
        { from: 'relay.attacker' },
      ),
    ).rejects.toThrow('Access denied');
  });

  it('allows messages when no deny rules match', async () => {
    await relay.registerEndpoint('relay.agent.allowed');

    const result = await relay.publish(
      'relay.agent.allowed',
      { msg: 'ok' },
      { from: 'relay.friendly' },
    );

    expect(result.deliveredTo).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Subscribe - synchronous dispatch
// ---------------------------------------------------------------------------

describe('subscribe - dispatch', () => {
  it('delivers messages to subscription handlers synchronously on publish', async () => {
    const received: RelayEnvelope[] = [];

    await relay.registerEndpoint('relay.agent.push');
    relay.subscribe('relay.agent.push', (envelope) => {
      received.push(envelope);
    });

    await relay.publish(
      'relay.agent.push',
      { hello: 'push' },
      { from: 'relay.sender' },
    );

    // Dispatch is synchronous — no wait needed
    expect(received.length).toBe(1);
    expect(received[0].subject).toBe('relay.agent.push');
    expect(received[0].payload).toEqual({ hello: 'push' });
  });

  it('delivers to multiple subscribers', async () => {
    const received1: RelayEnvelope[] = [];
    const received2: RelayEnvelope[] = [];

    await relay.registerEndpoint('relay.agent.multi-sub');
    relay.subscribe('relay.agent.multi-sub', (envelope) => {
      received1.push(envelope);
    });
    relay.subscribe('relay.agent.multi-sub', (envelope) => {
      received2.push(envelope);
    });

    await relay.publish(
      'relay.agent.multi-sub',
      { data: 'multi' },
      { from: 'relay.sender' },
    );

    expect(received1.length).toBe(1);
    expect(received2.length).toBe(1);
  });

  it('wildcard subscription matches published messages', async () => {
    const received: RelayEnvelope[] = [];

    await relay.registerEndpoint('relay.agent.proj.backend');
    relay.subscribe('relay.agent.>', (envelope) => {
      received.push(envelope);
    });

    await relay.publish(
      'relay.agent.proj.backend',
      { data: 'wildcard' },
      { from: 'relay.sender' },
    );

    expect(received.length).toBe(1);
    expect(received[0].subject).toBe('relay.agent.proj.backend');
  });

  it('unsubscribe stops handler from receiving messages', async () => {
    const received: RelayEnvelope[] = [];

    await relay.registerEndpoint('relay.agent.unsub');
    const unsub = relay.subscribe('relay.agent.unsub', (envelope) => {
      received.push(envelope);
    });

    // Unsubscribe before publishing
    unsub();

    await relay.publish(
      'relay.agent.unsub',
      { data: 'ignored' },
      { from: 'relay.sender' },
    );

    expect(received.length).toBe(0);
  });

  it('moves message to failed/ when handler throws', async () => {
    const info = await relay.registerEndpoint('relay.agent.fail-handler');
    relay.subscribe('relay.agent.fail-handler', () => {
      throw new Error('handler crashed');
    });

    await relay.publish(
      'relay.agent.fail-handler',
      { data: 'will fail' },
      { from: 'relay.sender' },
    );

    // The message should have been moved to failed/
    const mailboxesDir = path.join(tmpDir, 'mailboxes');
    const store = new MaildirStore({ rootDir: mailboxesDir });
    const failedMessages = await store.listFailed(info.hash);
    expect(failedMessages.length).toBeGreaterThanOrEqual(1);
  });

  it('updates budget on delivery (increments hopCount, appends ancestor)', async () => {
    const received: RelayEnvelope[] = [];

    await relay.registerEndpoint('relay.agent.budget-update');
    relay.subscribe('relay.agent.budget-update', (envelope) => {
      received.push(envelope);
    });

    await relay.publish(
      'relay.agent.budget-update',
      { data: 1 },
      { from: 'relay.sender' },
    );

    expect(received.length).toBe(1);
    expect(received[0].budget.hopCount).toBe(1);
    expect(received[0].budget.ancestorChain).toContain('relay.agent.budget-update');
    expect(received[0].budget.callBudgetRemaining).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Signals (ephemeral, no disk)
// ---------------------------------------------------------------------------

describe('signals', () => {
  it('emits and receives a signal', () => {
    const received: Array<{ subject: string; signal: Signal }> = [];

    relay.onSignal('relay.agent.>', (subject, signal) => {
      received.push({ subject, signal });
    });

    const testSignal: Signal = {
      type: 'typing',
      state: 'active',
      endpointSubject: 'relay.agent.proj.backend',
      timestamp: new Date().toISOString(),
    };

    relay.signal('relay.agent.proj.backend', testSignal);

    expect(received.length).toBe(1);
    expect(received[0].subject).toBe('relay.agent.proj.backend');
    expect(received[0].signal.type).toBe('typing');
  });

  it('unsubscribe stops signal delivery', () => {
    const received: Signal[] = [];

    const unsub = relay.onSignal('relay.agent.>', (_subject, signal) => {
      received.push(signal);
    });

    unsub();

    relay.signal('relay.agent.proj.backend', {
      type: 'typing',
      state: 'active',
      endpointSubject: 'relay.agent.proj.backend',
      timestamp: new Date().toISOString(),
    });

    expect(received.length).toBe(0);
  });

  it('pattern matching filters signals correctly', () => {
    const received: string[] = [];

    relay.onSignal('relay.agent.proj.*', (subject) => {
      received.push(subject);
    });

    relay.signal('relay.agent.proj.backend', {
      type: 'typing',
      state: 'active',
      endpointSubject: 'relay.agent.proj.backend',
      timestamp: new Date().toISOString(),
    });

    relay.signal('relay.system.monitor', {
      type: 'presence',
      state: 'online',
      endpointSubject: 'relay.system.monitor',
      timestamp: new Date().toISOString(),
    });

    expect(received.length).toBe(1);
    expect(received[0]).toBe('relay.agent.proj.backend');
  });
});

// ---------------------------------------------------------------------------
// Dead letter queue
// ---------------------------------------------------------------------------

describe('dead letters', () => {
  it('captures messages with no matching endpoints', async () => {
    const result = await relay.publish(
      'relay.agent.nomatch',
      { data: 'lost' },
      { from: 'relay.sender' },
    );

    expect(result.deliveredTo).toBe(0);

    const metrics = relay.getMetrics();
    expect(metrics.byStatus['failed']).toBeGreaterThanOrEqual(1);
  });

  it('getDeadLetters returns empty array when no dead letters exist', async () => {
    const info = await relay.registerEndpoint('relay.agent.clean');

    const deadLetters = await relay.getDeadLetters({ endpointHash: info.hash });
    expect(deadLetters).toEqual([]);
  });

  it('getDeadLetters returns budget-rejected messages', async () => {
    const info = await relay.registerEndpoint('relay.agent.dlq-query');

    await relay.publish(
      'relay.agent.dlq-query',
      { data: 'expired' },
      { from: 'relay.sender', budget: { ttl: Date.now() - 1000 } },
    );

    const deadLetters = await relay.getDeadLetters({ endpointHash: info.hash });
    expect(deadLetters.length).toBe(1);
    expect(deadLetters[0].reason).toContain('expired');
  });
});

// ---------------------------------------------------------------------------
// Access rule management
// ---------------------------------------------------------------------------

describe('access rule management', () => {
  it('addAccessRule delegates to AccessControl and persists the rule', () => {
    relay.addAccessRule({
      from: 'relay.attacker',
      to: 'relay.agent.secret',
      action: 'deny',
      priority: 100,
    });

    const rules = relay.listAccessRules();
    expect(rules.length).toBe(1);
    expect(rules[0]).toEqual({
      from: 'relay.attacker',
      to: 'relay.agent.secret',
      action: 'deny',
      priority: 100,
    });
  });

  it('listAccessRules returns rules sorted by priority (highest first)', () => {
    relay.addAccessRule({
      from: 'relay.a',
      to: 'relay.b',
      action: 'deny',
      priority: 10,
    });
    relay.addAccessRule({
      from: 'relay.c',
      to: 'relay.d',
      action: 'allow',
      priority: 50,
    });
    relay.addAccessRule({
      from: 'relay.e',
      to: 'relay.f',
      action: 'deny',
      priority: 30,
    });

    const rules = relay.listAccessRules();
    expect(rules.length).toBe(3);
    expect(rules[0].priority).toBe(50);
    expect(rules[1].priority).toBe(30);
    expect(rules[2].priority).toBe(10);
  });

  it('removeAccessRule removes the matching rule', () => {
    relay.addAccessRule({
      from: 'relay.x',
      to: 'relay.y',
      action: 'deny',
      priority: 100,
    });

    expect(relay.listAccessRules().length).toBe(1);

    relay.removeAccessRule('relay.x', 'relay.y');

    expect(relay.listAccessRules().length).toBe(0);
  });

  it('removeAccessRule is a no-op when no rule matches', () => {
    relay.addAccessRule({
      from: 'relay.a',
      to: 'relay.b',
      action: 'deny',
      priority: 10,
    });

    relay.removeAccessRule('relay.nonexistent', 'relay.other');

    expect(relay.listAccessRules().length).toBe(1);
  });

  it('listAccessRules returns a shallow copy (mutations do not affect internal state)', () => {
    relay.addAccessRule({
      from: 'relay.a',
      to: 'relay.b',
      action: 'deny',
      priority: 10,
    });

    const rules = relay.listAccessRules();
    rules.pop();

    expect(relay.listAccessRules().length).toBe(1);
  });

  it('addAccessRule throws after close', async () => {
    await relay.close();
    expect(() =>
      relay.addAccessRule({
        from: 'relay.a',
        to: 'relay.b',
        action: 'deny',
        priority: 10,
      }),
    ).toThrow('RelayCore has been closed');
  });

  it('removeAccessRule throws after close', async () => {
    await relay.close();
    expect(() => relay.removeAccessRule('relay.a', 'relay.b')).toThrow(
      'RelayCore has been closed',
    );
  });

  it('listAccessRules throws after close', async () => {
    await relay.close();
    expect(() => relay.listAccessRules()).toThrow('RelayCore has been closed');
  });

  it('added deny rule is enforced by publish', async () => {
    await relay.registerEndpoint('relay.agent.guarded');

    relay.addAccessRule({
      from: 'relay.blocked-sender',
      to: 'relay.agent.guarded',
      action: 'deny',
      priority: 100,
    });

    await expect(
      relay.publish(
        'relay.agent.guarded',
        { data: 'should-be-blocked' },
        { from: 'relay.blocked-sender' },
      ),
    ).rejects.toThrow('Access denied');
  });

  it('removed deny rule no longer blocks publish', async () => {
    await relay.registerEndpoint('relay.agent.unblocked');

    relay.addAccessRule({
      from: 'relay.temp-blocked',
      to: 'relay.agent.unblocked',
      action: 'deny',
      priority: 100,
    });

    // Should be blocked
    await expect(
      relay.publish(
        'relay.agent.unblocked',
        { data: 'blocked' },
        { from: 'relay.temp-blocked' },
      ),
    ).rejects.toThrow('Access denied');

    // Remove the rule
    relay.removeAccessRule('relay.temp-blocked', 'relay.agent.unblocked');

    // Should now succeed
    const result = await relay.publish(
      'relay.agent.unblocked',
      { data: 'allowed' },
      { from: 'relay.temp-blocked' },
    );
    expect(result.deliveredTo).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Index rebuild
// ---------------------------------------------------------------------------

describe('index rebuild', () => {
  it('rebuilds the SQLite index from Maildir files', async () => {
    // Use a relay with no subscribers so messages stay in new/
    await relay.close();
    relay = createRelay();

    await relay.registerEndpoint('relay.agent.rebuild');

    // Publish several messages — they go to new/ since no subscribers
    await relay.publish('relay.agent.rebuild', { data: 1 }, { from: 'relay.sender' });
    await relay.publish('relay.agent.rebuild', { data: 2 }, { from: 'relay.sender' });
    await relay.publish('relay.agent.rebuild', { data: 3 }, { from: 'relay.sender' });

    // Verify initial metrics
    const metricsBefore = relay.getMetrics();
    expect(metricsBefore.totalMessages).toBeGreaterThanOrEqual(3);

    // Rebuild the index
    const count = await relay.rebuildIndex();
    expect(count).toBeGreaterThanOrEqual(3);

    // Verify metrics after rebuild match
    const metricsAfter = relay.getMetrics();
    expect(metricsAfter.totalMessages).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

describe('metrics', () => {
  it('returns aggregate metrics', async () => {
    await relay.registerEndpoint('relay.agent.metrics');

    await relay.publish('relay.agent.metrics', { data: 1 }, { from: 'relay.sender' });
    await relay.publish('relay.agent.metrics', { data: 2 }, { from: 'relay.sender' });

    const metrics = relay.getMetrics();
    expect(metrics.totalMessages).toBeGreaterThanOrEqual(2);
    expect(metrics.bySubject.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

describe('graceful shutdown', () => {
  it('stops watchers and closes DB on close', async () => {
    await relay.registerEndpoint('relay.agent.shutdown');
    relay.subscribe('relay.agent.shutdown', () => {});

    await relay.close();

    await expect(
      relay.publish('relay.agent.shutdown', { data: 1 }, { from: 'relay.sender' }),
    ).rejects.toThrow('closed');
  });

  it('publishing after unregister does not deliver', async () => {
    await relay.registerEndpoint('relay.agent.unreg');

    await relay.unregisterEndpoint('relay.agent.unreg');

    const result = await relay.publish(
      'relay.agent.unreg',
      { data: 1 },
      { from: 'relay.sender' },
    );
    expect(result.deliveredTo).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Full end-to-end integration
// ---------------------------------------------------------------------------

describe('end-to-end integration', () => {
  it('register -> subscribe -> publish -> receive -> verify index', async () => {
    const received: RelayEnvelope[] = [];

    await relay.registerEndpoint('relay.agent.e2e');
    relay.subscribe('relay.agent.e2e', (envelope) => {
      received.push(envelope);
    });

    const result = await relay.publish(
      'relay.agent.e2e',
      { e2e: true },
      { from: 'relay.agent.orchestrator', replyTo: 'relay.agent.orchestrator.reply' },
    );

    expect(result.messageId).toBeDefined();
    expect(result.deliveredTo).toBe(1);

    // Synchronous dispatch — handler already called
    expect(received.length).toBe(1);
    expect(received[0].subject).toBe('relay.agent.e2e');
    expect(received[0].from).toBe('relay.agent.orchestrator');
    expect(received[0].replyTo).toBe('relay.agent.orchestrator.reply');
    expect(received[0].payload).toEqual({ e2e: true });
    expect(received[0].budget.hopCount).toBe(1);
    expect(received[0].budget.ancestorChain).toContain('relay.agent.e2e');

    // Verify metrics
    const metrics = relay.getMetrics();
    expect(metrics.totalMessages).toBeGreaterThanOrEqual(1);
  });

  it('mixed publish + signal workflow', async () => {
    const messages: RelayEnvelope[] = [];
    const signals: Array<{ subject: string; signal: Signal }> = [];

    await relay.registerEndpoint('relay.agent.mixed');

    relay.subscribe('relay.agent.mixed', (envelope) => {
      messages.push(envelope);
    });

    relay.onSignal('relay.agent.mixed', (subject, signal) => {
      signals.push({ subject, signal });
    });

    // Publish a persistent message
    await relay.publish(
      'relay.agent.mixed',
      { persistent: true },
      { from: 'relay.sender' },
    );

    // Emit an ephemeral signal
    relay.signal('relay.agent.mixed', {
      type: 'typing',
      state: 'active',
      endpointSubject: 'relay.agent.mixed',
      timestamp: new Date().toISOString(),
    });

    // Both should have been received
    expect(messages.length).toBe(1);
    expect(signals.length).toBe(1);

    // Persistent message is indexed
    const metrics = relay.getMetrics();
    expect(metrics.totalMessages).toBeGreaterThanOrEqual(1);
  });

  it('publish to multiple endpoints with subscriber on one', async () => {
    const received: RelayEnvelope[] = [];

    await relay.registerEndpoint('relay.agent.proj.a');
    await relay.registerEndpoint('relay.agent.proj.b');

    relay.subscribe('relay.agent.proj.a', (envelope) => {
      received.push(envelope);
    });

    // Publish to endpoint A — subscriber should receive it
    const result = await relay.publish(
      'relay.agent.proj.a',
      { target: 'a' },
      { from: 'relay.sender' },
    );

    expect(result.deliveredTo).toBe(1);
    expect(received.length).toBe(1);
    expect(received[0].payload).toEqual({ target: 'a' });
  });
});

// ---------------------------------------------------------------------------
// Reliability pipeline integration
// ---------------------------------------------------------------------------

describe('reliability pipeline integration', () => {
  let rTmpDir: string;
  let rRelay: RelayCore;

  beforeEach(async () => {
    rTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-reliability-test-'));
    rRelay = new RelayCore({
      dataDir: rTmpDir,
      reliability: {
        rateLimit: { enabled: true, maxPerWindow: 5, windowSecs: 60 },
        circuitBreaker: { enabled: true, failureThreshold: 3, cooldownMs: 1000 },
        backpressure: { enabled: true, maxMailboxSize: 10, pressureWarningAt: 0.8 },
      },
    });
  });

  afterEach(async () => {
    await rRelay.close();
    await fs.rm(rTmpDir, { recursive: true, force: true });
  });

  it('rate limit check runs before fan-out (one check for multi-endpoint publish)', async () => {
    await rRelay.registerEndpoint('relay.agent.proj.a');
    await rRelay.registerEndpoint('relay.agent.proj.b');

    // Exhaust the rate limit (maxPerWindow: 5) by publishing to endpoint A
    for (let i = 0; i < 5; i++) {
      await rRelay.publish(
        'relay.agent.proj.a',
        { i },
        { from: 'relay.flood' },
      );
    }

    // The 6th publish from the same sender should be rate-limited
    // even though it targets a different endpoint — rate limit is per-sender, before fan-out
    const result = await rRelay.publish(
      'relay.agent.proj.b',
      { data: 'blocked' },
      { from: 'relay.flood' },
    );

    expect(result.deliveredTo).toBe(0);
    expect(result.rejected).toBeDefined();
    expect(result.rejected!.some((r) => r.reason === 'rate_limited')).toBe(true);
  });

  it('rate-limited publish returns rejected array with reason', async () => {
    await rRelay.registerEndpoint('relay.agent.rate');

    // Exhaust the rate limit
    for (let i = 0; i < 5; i++) {
      await rRelay.publish(
        'relay.agent.rate',
        { i },
        { from: 'relay.sender.rate' },
      );
    }

    const result = await rRelay.publish(
      'relay.agent.rate',
      { data: 'over-limit' },
      { from: 'relay.sender.rate' },
    );

    expect(result.messageId).toBe('');
    expect(result.deliveredTo).toBe(0);
    expect(result.rejected).toEqual([
      { endpointHash: '*', reason: 'rate_limited' },
    ]);
  });

  it('backpressure rejection skips Maildir delivery', async () => {
    // Use a relay with a very small mailbox to trigger backpressure
    await rRelay.close();
    rRelay = new RelayCore({
      dataDir: rTmpDir,
      reliability: {
        backpressure: { enabled: true, maxMailboxSize: 3, pressureWarningAt: 0.5 },
        rateLimit: { enabled: false },
      },
    });

    const info = await rRelay.registerEndpoint('relay.agent.bp');
    // No subscriber — messages stay in new/, building up backpressure

    // Fill the mailbox to capacity
    for (let i = 0; i < 3; i++) {
      await rRelay.publish(
        'relay.agent.bp',
        { i },
        { from: 'relay.sender.bp' },
      );
    }

    // Next publish should be rejected by backpressure
    const result = await rRelay.publish(
      'relay.agent.bp',
      { data: 'backpressured' },
      { from: 'relay.sender.bp' },
    );

    expect(result.deliveredTo).toBe(0);
    expect(result.rejected).toBeDefined();
    expect(result.rejected!.some((r) => r.reason === 'backpressure')).toBe(true);

    // Verify no file was written for the rejected message by checking
    // the new/ directory still has exactly 3 files
    const newDir = path.join(info.maildirPath, 'new');
    const files = await fs.readdir(newDir);
    expect(files.length).toBe(3);
  });

  it('circuit breaker rejection skips Maildir delivery', async () => {
    await rRelay.close();
    rRelay = new RelayCore({
      dataDir: rTmpDir,
      reliability: {
        circuitBreaker: { enabled: true, failureThreshold: 3, cooldownMs: 60_000 },
        rateLimit: { enabled: false },
      },
    });

    const info = await rRelay.registerEndpoint('relay.agent.cb');

    // Cause Maildir write errors by removing the tmp/ directory.
    // This triggers recordFailure WITHOUT a preceding recordSuccess,
    // so consecutiveFailures actually accumulates and trips the breaker.
    await fs.rm(path.join(info.maildirPath, 'tmp'), { recursive: true, force: true });

    // Cause enough failures to trip the circuit breaker (failureThreshold: 3)
    for (let i = 0; i < 3; i++) {
      await rRelay.publish(
        'relay.agent.cb',
        { i },
        { from: 'relay.sender.cb' },
      );
    }

    // Restore the tmp/ directory so the Maildir write check isn't what blocks
    // the next publish — the circuit breaker should block it first
    await fs.mkdir(path.join(info.maildirPath, 'tmp'), { recursive: true });

    // The breaker should now be OPEN — next publish should be rejected
    const result = await rRelay.publish(
      'relay.agent.cb',
      { data: 'circuit-open' },
      { from: 'relay.sender.cb' },
    );

    expect(result.deliveredTo).toBe(0);
    expect(result.rejected).toBeDefined();
    expect(result.rejected!.some((r) => r.reason === 'circuit_open')).toBe(true);

    // Verify no new file was written for the circuit-breaker-rejected message
    const newDir = path.join(info.maildirPath, 'new');
    const newFiles = await fs.readdir(newDir);
    expect(newFiles.length).toBe(0);
  });

  it('circuit breaker records success after successful delivery', async () => {
    await rRelay.close();
    rRelay = new RelayCore({
      dataDir: rTmpDir,
      reliability: {
        circuitBreaker: { enabled: true, failureThreshold: 3, cooldownMs: 60_000 },
        rateLimit: { enabled: false },
      },
    });

    await rRelay.registerEndpoint('relay.agent.cb-ok');
    rRelay.subscribe('relay.agent.cb-ok', () => {
      // Successful handler — does nothing
    });

    // Publish a message that succeeds
    const result = await rRelay.publish(
      'relay.agent.cb-ok',
      { data: 'success' },
      { from: 'relay.sender.cb-ok' },
    );

    expect(result.deliveredTo).toBe(1);

    // If circuit breaker recorded success, subsequent publishes should still work
    // (breaker stays CLOSED). Publish more messages to confirm.
    const result2 = await rRelay.publish(
      'relay.agent.cb-ok',
      { data: 'also-success' },
      { from: 'relay.sender.cb-ok' },
    );

    expect(result2.deliveredTo).toBe(1);
    expect(result2.rejected).toBeUndefined();
  });

  it('circuit breaker records failure on Maildir write error', async () => {
    await rRelay.close();
    rRelay = new RelayCore({
      dataDir: rTmpDir,
      reliability: {
        circuitBreaker: { enabled: true, failureThreshold: 2, cooldownMs: 60_000 },
        rateLimit: { enabled: false },
      },
    });

    const info = await rRelay.registerEndpoint('relay.agent.cb-fail');

    // Cause Maildir write errors by removing the tmp/ directory
    // (deliver() writes to tmp/ first, then renames to new/)
    await fs.rm(path.join(info.maildirPath, 'tmp'), { recursive: true, force: true });

    // These publishes should fail at the Maildir write stage
    await rRelay.publish(
      'relay.agent.cb-fail',
      { data: 'fail1' },
      { from: 'relay.sender.write' },
    );
    await rRelay.publish(
      'relay.agent.cb-fail',
      { data: 'fail2' },
      { from: 'relay.sender.write' },
    );

    // After 2 failures (failureThreshold: 2), the circuit breaker should trip
    const result = await rRelay.publish(
      'relay.agent.cb-fail',
      { data: 'should-be-circuit-open' },
      { from: 'relay.sender.write' },
    );

    expect(result.deliveredTo).toBe(0);
    expect(result.rejected).toBeDefined();
    expect(result.rejected!.some((r) => r.reason === 'circuit_open')).toBe(true);
  });

  it('backpressure signal emitted when pressure exceeds warning threshold', async () => {
    await rRelay.close();
    rRelay = new RelayCore({
      dataDir: rTmpDir,
      reliability: {
        backpressure: { enabled: true, maxMailboxSize: 5, pressureWarningAt: 0.6 },
        rateLimit: { enabled: false },
      },
    });

    await rRelay.registerEndpoint('relay.agent.bp-signal');
    // No subscriber so messages stay in new/

    const signals: Array<{ subject: string; signal: Signal }> = [];
    rRelay.onSignal('relay.agent.bp-signal', (subject, signal) => {
      signals.push({ subject, signal });
    });

    // Publish 3 messages to reach 3/5 = 0.6 pressure (equal to warning threshold)
    for (let i = 0; i < 3; i++) {
      await rRelay.publish(
        'relay.agent.bp-signal',
        { i },
        { from: 'relay.sender.bp-signal' },
      );
    }

    // At 3/5 = 0.6 >= pressureWarningAt (0.6), a backpressure warning signal should be emitted
    // The signal is emitted during the 4th message's delivery check (when count is 3)
    // Actually, the count is checked BEFORE delivery, so:
    // Message 1: count=0 -> 0/5=0.0 < 0.6, no signal
    // Message 2: count=1 -> 1/5=0.2 < 0.6, no signal
    // Message 3: count=2 -> 2/5=0.4 < 0.6, no signal
    // Message 4: count=3 -> 3/5=0.6 >= 0.6, signal!
    await rRelay.publish(
      'relay.agent.bp-signal',
      { data: 'trigger-signal' },
      { from: 'relay.sender.bp-signal' },
    );

    expect(signals.length).toBeGreaterThanOrEqual(1);
    const bpSignal = signals.find((s) => s.signal.type === 'backpressure');
    expect(bpSignal).toBeDefined();
    expect(bpSignal!.signal.state).toBe('warning');
    expect(bpSignal!.signal.data).toBeDefined();
  });

  it('mailboxPressure included in PublishResult for all endpoints', async () => {
    await rRelay.close();
    rRelay = new RelayCore({
      dataDir: rTmpDir,
      reliability: {
        backpressure: { enabled: true, maxMailboxSize: 100, pressureWarningAt: 0.9 },
        rateLimit: { enabled: false },
      },
    });

    const infoA = await rRelay.registerEndpoint('relay.agent.pressure.a');
    // No subscriber so messages stay in new/

    // Publish a message to create some pressure
    const result = await rRelay.publish(
      'relay.agent.pressure.a',
      { data: 'pressure-test' },
      { from: 'relay.sender.pressure' },
    );

    // mailboxPressure should be included with pressure for endpoint A
    expect(result.mailboxPressure).toBeDefined();
    expect(result.mailboxPressure![infoA.hash]).toBeDefined();
    expect(typeof result.mailboxPressure![infoA.hash]).toBe('number');
    expect(result.mailboxPressure![infoA.hash]).toBeGreaterThanOrEqual(0);
  });

  it('reliability rejections do NOT appear in dead letter queue', async () => {
    await rRelay.close();
    rRelay = new RelayCore({
      dataDir: rTmpDir,
      reliability: {
        backpressure: { enabled: true, maxMailboxSize: 2, pressureWarningAt: 0.5 },
        rateLimit: { enabled: false },
      },
    });

    const info = await rRelay.registerEndpoint('relay.agent.no-dlq');
    // No subscriber — messages stay in new/

    // Fill mailbox to capacity
    for (let i = 0; i < 2; i++) {
      await rRelay.publish(
        'relay.agent.no-dlq',
        { i },
        { from: 'relay.sender.no-dlq' },
      );
    }

    // This message should be rejected by backpressure
    const result = await rRelay.publish(
      'relay.agent.no-dlq',
      { data: 'rejected' },
      { from: 'relay.sender.no-dlq' },
    );

    expect(result.deliveredTo).toBe(0);
    expect(result.rejected!.some((r) => r.reason === 'backpressure')).toBe(true);

    // The backpressure-rejected message should NOT appear in the DLQ
    const deadLetters = await rRelay.getDeadLetters({ endpointHash: info.hash });
    // DLQ should have 0 entries — backpressure rejections skip DLQ
    expect(deadLetters.length).toBe(0);
  });

  it('publish works normally with all reliability features disabled', async () => {
    await rRelay.close();
    rRelay = new RelayCore({
      dataDir: rTmpDir,
      reliability: {
        rateLimit: { enabled: false },
        circuitBreaker: { enabled: false },
        backpressure: { enabled: false },
      },
    });

    const received: RelayEnvelope[] = [];
    await rRelay.registerEndpoint('relay.agent.disabled');
    rRelay.subscribe('relay.agent.disabled', (env) => {
      received.push(env);
    });

    const result = await rRelay.publish(
      'relay.agent.disabled',
      { data: 'normal' },
      { from: 'relay.sender.disabled' },
    );

    expect(result.deliveredTo).toBe(1);
    expect(result.rejected).toBeUndefined();
    expect(received.length).toBe(1);
    expect(received[0].payload).toEqual({ data: 'normal' });
  });

  it('budget enforcement still runs after reliability checks pass', async () => {
    // Use the default relay which has reliability features enabled
    const info = await rRelay.registerEndpoint('relay.agent.budget-after-reliability');

    // Publish with an expired TTL — should pass reliability checks
    // but fail budget enforcement
    const result = await rRelay.publish(
      'relay.agent.budget-after-reliability',
      { data: 'expired' },
      { from: 'relay.sender.budget', budget: { ttl: Date.now() - 1000 } },
    );

    expect(result.deliveredTo).toBe(0);

    // Budget-rejected message should go to DLQ (unlike reliability rejections)
    const deadLetters = await rRelay.getDeadLetters({ endpointHash: info.hash });
    expect(deadLetters.length).toBeGreaterThanOrEqual(1);
    expect(deadLetters.some((dl) => dl.reason.includes('expired'))).toBe(true);
  });

  it('multiple endpoints: some rejected (backpressure), some delivered', async () => {
    await rRelay.close();
    rRelay = new RelayCore({
      dataDir: rTmpDir,
      reliability: {
        backpressure: { enabled: true, maxMailboxSize: 2, pressureWarningAt: 0.5 },
        rateLimit: { enabled: false },
      },
    });

    const infoA = await rRelay.registerEndpoint('relay.agent.multi.a');
    const infoB = await rRelay.registerEndpoint('relay.agent.multi.b');

    // Fill endpoint A's mailbox to capacity (no subscriber, messages stay in new/)
    for (let i = 0; i < 2; i++) {
      await rRelay.publish(
        'relay.agent.multi.a',
        { i },
        { from: 'relay.sender.multi' },
      );
    }

    // Now publish to both endpoints at once using a subscriber on endpoint B
    const received: RelayEnvelope[] = [];
    rRelay.subscribe('relay.agent.multi.b', (env) => {
      received.push(env);
    });

    // Publish separately to each — A should reject, B should deliver
    const resultA = await rRelay.publish(
      'relay.agent.multi.a',
      { target: 'a' },
      { from: 'relay.sender.multi' },
    );

    const resultB = await rRelay.publish(
      'relay.agent.multi.b',
      { target: 'b' },
      { from: 'relay.sender.multi' },
    );

    // Endpoint A should be rejected by backpressure
    expect(resultA.deliveredTo).toBe(0);
    expect(resultA.rejected).toBeDefined();
    expect(resultA.rejected!.some((r) => r.reason === 'backpressure' && r.endpointHash === infoA.hash)).toBe(true);

    // Endpoint B should be delivered successfully
    expect(resultB.deliveredTo).toBe(1);
    expect(received.length).toBe(1);
    expect(received[0].payload).toEqual({ target: 'b' });
  });
});
