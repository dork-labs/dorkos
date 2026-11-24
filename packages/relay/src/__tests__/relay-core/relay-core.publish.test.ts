import { describe, it, expect } from 'vitest';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { RelayCore } from '../../relay-core.js';
import { MaildirStore } from '../../maildir-store.js';
import type { RelayEnvelope, Signal } from '@dorkos/shared/relay-schemas';
import { useRelayCore } from './relay-core.fixtures.js';

const h = useRelayCore();

describe('constructor and lifecycle', () => {
  it('close() is idempotent — safe to call multiple times', async () => {
    await h.relay.close();
    await h.relay.close(); // Should not throw
  });

  it('throws after close for publish', async () => {
    await h.relay.close();
    await expect(
      h.relay.publish('relay.test', { data: true }, { from: 'relay.sender' })
    ).rejects.toThrow('RelayCore has been closed');
  });
});

// ---------------------------------------------------------------------------
// Endpoint registration
// ---------------------------------------------------------------------------

describe('endpoint registration', () => {
  it('rejects duplicate endpoint registration', async () => {
    await h.relay.registerEndpoint('relay.agent.dup');
    await expect(h.relay.registerEndpoint('relay.agent.dup')).rejects.toThrow(
      'Endpoint already registered'
    );
  });
});

// ---------------------------------------------------------------------------
// Publish - basic
// ---------------------------------------------------------------------------

describe('publish - basic', () => {
  it('dead-letters when no endpoints or adapters match', async () => {
    const result = await h.relay.publish(
      'relay.nobody.here',
      { msg: 'hello' },
      { from: 'relay.sender' }
    );

    expect(result.deliveredTo).toBe(0);
    // Verify DLQ was called
    const deadLetters = await h.relay.getDeadLetters();
    expect(deadLetters.some((d) => d.envelope?.subject === 'relay.nobody.here')).toBe(true);
  });

  it('rejects invalid subjects', async () => {
    await expect(h.relay.publish('', { msg: 'hello' }, { from: 'relay.sender' })).rejects.toThrow(
      'Invalid subject'
    );
  });
});

// ---------------------------------------------------------------------------
// Publish - fan-out to multiple endpoints
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Publish - budget enforcement
// ---------------------------------------------------------------------------

describe('publish - budget enforcement', () => {
  it('rejects messages with expired TTL to DLQ', async () => {
    const info = await h.relay.registerEndpoint('relay.agent.budget-ttl');

    const result = await h.relay.publish(
      'relay.agent.budget-ttl',
      { data: 'expired' },
      { from: 'relay.sender', budget: { ttl: Date.now() - 1000 } }
    );

    expect(result.deliveredTo).toBe(0);

    const deadLetters = await h.relay.getDeadLetters({ endpointHash: info.hash });
    expect(deadLetters.length).toBeGreaterThanOrEqual(1);
    expect(deadLetters.some((dl) => dl.reason.includes('expired'))).toBe(true);
  });

  it('uses custom budget options from constructor', async () => {
    await h.relay.close();

    h.relay = new RelayCore({
      dataDir: h.tmpDir,
      maxHops: 2,
      defaultCallBudget: 3,
    });

    const received: RelayEnvelope[] = [];
    await h.relay.registerEndpoint('relay.agent.custom-budget');
    h.relay.subscribe('relay.agent.custom-budget', (env) => {
      received.push(env);
    });

    await h.relay.publish('relay.agent.custom-budget', { data: 1 }, { from: 'relay.sender' });

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
    await h.relay.close();

    // Write the deny rule directly to disk before constructing a new relay
    const rulesPath = path.join(h.tmpDir, 'access-rules.json');
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
    h.relay = new RelayCore({ dataDir: h.tmpDir });
    await h.relay.registerEndpoint('relay.agent.protected');

    await expect(
      h.relay.publish('relay.agent.protected', { data: 'blocked' }, { from: 'relay.attacker' })
    ).rejects.toThrow('Access denied');
  });
});

// ---------------------------------------------------------------------------
// Subscribe - synchronous dispatch
// ---------------------------------------------------------------------------

describe('subscribe - dispatch', () => {
  it('delivers messages to subscription handlers synchronously on publish', async () => {
    const received: RelayEnvelope[] = [];

    await h.relay.registerEndpoint('relay.agent.push');
    h.relay.subscribe('relay.agent.push', (envelope) => {
      received.push(envelope);
    });

    await h.relay.publish('relay.agent.push', { hello: 'push' }, { from: 'relay.sender' });

    // Dispatch is synchronous — no wait needed
    expect(received.length).toBe(1);
    expect(received[0].subject).toBe('relay.agent.push');
    expect(received[0].payload).toEqual({ hello: 'push' });
  });

  it('unsubscribe stops handler from receiving messages', async () => {
    const received: RelayEnvelope[] = [];

    await h.relay.registerEndpoint('relay.agent.unsub');
    const unsub = h.relay.subscribe('relay.agent.unsub', (envelope) => {
      received.push(envelope);
    });

    // Unsubscribe before publishing
    unsub();

    await h.relay.publish('relay.agent.unsub', { data: 'ignored' }, { from: 'relay.sender' });

    expect(received.length).toBe(0);
  });

  it('moves message to failed/ when handler throws', async () => {
    const info = await h.relay.registerEndpoint('relay.agent.fail-handler');
    h.relay.subscribe('relay.agent.fail-handler', () => {
      throw new Error('handler crashed');
    });

    await h.relay.publish(
      'relay.agent.fail-handler',
      { data: 'will fail' },
      { from: 'relay.sender' }
    );

    // The message should have been moved to failed/
    const mailboxesDir = path.join(h.tmpDir, 'mailboxes');
    const store = new MaildirStore({ rootDir: mailboxesDir });
    const failedMessages = await store.listFailed(info.hash);
    expect(failedMessages.length).toBeGreaterThanOrEqual(1);
  });

  it('updates budget on delivery (increments hopCount, appends ancestor)', async () => {
    const received: RelayEnvelope[] = [];

    await h.relay.registerEndpoint('relay.agent.budget-update');
    h.relay.subscribe('relay.agent.budget-update', (envelope) => {
      received.push(envelope);
    });

    await h.relay.publish('relay.agent.budget-update', { data: 1 }, { from: 'relay.sender' });

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

    h.relay.onSignal('relay.agent.>', (subject, signal) => {
      received.push({ subject, signal });
    });

    const testSignal: Signal = {
      type: 'typing',
      state: 'active',
      endpointSubject: 'relay.agent.proj.backend',
      timestamp: new Date().toISOString(),
    };

    h.relay.signal('relay.agent.proj.backend', testSignal);

    expect(received.length).toBe(1);
    expect(received[0].subject).toBe('relay.agent.proj.backend');
    expect(received[0].signal.type).toBe('typing');
  });
});

// ---------------------------------------------------------------------------
// Dead letter queue
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Access rule management
// ---------------------------------------------------------------------------

describe('access rule management', () => {
  it('addAccessRule delegates to AccessControl and persists the rule', () => {
    h.relay.addAccessRule({
      from: 'relay.attacker',
      to: 'relay.agent.secret',
      action: 'deny',
      priority: 100,
    });

    const rules = h.relay.listAccessRules();
    expect(rules.length).toBe(1);
    expect(rules[0]).toEqual({
      from: 'relay.attacker',
      to: 'relay.agent.secret',
      action: 'deny',
      priority: 100,
    });
  });

  it('added deny rule is enforced by publish', async () => {
    await h.relay.registerEndpoint('relay.agent.guarded');

    h.relay.addAccessRule({
      from: 'relay.blocked-sender',
      to: 'relay.agent.guarded',
      action: 'deny',
      priority: 100,
    });

    await expect(
      h.relay.publish(
        'relay.agent.guarded',
        { data: 'should-be-blocked' },
        { from: 'relay.blocked-sender' }
      )
    ).rejects.toThrow('Access denied');
  });

  it('removed deny rule no longer blocks publish', async () => {
    await h.relay.registerEndpoint('relay.agent.unblocked');

    h.relay.addAccessRule({
      from: 'relay.temp-blocked',
      to: 'relay.agent.unblocked',
      action: 'deny',
      priority: 100,
    });

    // Should be blocked
    await expect(
      h.relay.publish('relay.agent.unblocked', { data: 'blocked' }, { from: 'relay.temp-blocked' })
    ).rejects.toThrow('Access denied');

    // Remove the rule
    h.relay.removeAccessRule('relay.temp-blocked', 'relay.agent.unblocked');

    // Should now succeed
    const result = await h.relay.publish(
      'relay.agent.unblocked',
      { data: 'allowed' },
      { from: 'relay.temp-blocked' }
    );
    expect(result.deliveredTo).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Index rebuild
// ---------------------------------------------------------------------------

describe('index rebuild', () => {
  it('rebuilds the SQLite index from Maildir files', async () => {
    await h.relay.registerEndpoint('relay.agent.rebuild');

    // Publish several messages — they go to new/ since no subscribers
    await h.relay.publish('relay.agent.rebuild', { data: 1 }, { from: 'relay.sender' });
    await h.relay.publish('relay.agent.rebuild', { data: 2 }, { from: 'relay.sender' });
    await h.relay.publish('relay.agent.rebuild', { data: 3 }, { from: 'relay.sender' });

    // Verify initial metrics
    const metricsBefore = h.relay.getMetrics();
    expect(metricsBefore.totalMessages).toBeGreaterThanOrEqual(3);

    // Rebuild the index
    const count = await h.relay.rebuildIndex();
    expect(count).toBeGreaterThanOrEqual(3);

    // Verify metrics after rebuild match
    const metricsAfter = h.relay.getMetrics();
    expect(metricsAfter.totalMessages).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

describe('graceful shutdown', () => {
  it('publishing after unregister does not deliver', async () => {
    await h.relay.registerEndpoint('relay.agent.unreg');

    await h.relay.unregisterEndpoint('relay.agent.unreg');

    const result = await h.relay.publish(
      'relay.agent.unreg',
      { data: 1 },
      { from: 'relay.sender' }
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

    await h.relay.registerEndpoint('relay.agent.e2e');
    h.relay.subscribe('relay.agent.e2e', (envelope) => {
      received.push(envelope);
    });

    const result = await h.relay.publish(
      'relay.agent.e2e',
      { e2e: true },
      { from: 'relay.agent.orchestrator', replyTo: 'relay.agent.orchestrator.reply' }
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
    const metrics = h.relay.getMetrics();
    expect(metrics.totalMessages).toBeGreaterThanOrEqual(1);
  });
});
