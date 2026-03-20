import { describe, it, expect } from 'vitest';
import {
  runAdapterComplianceSuite,
  createMockRelayPublisher,
  createMockRelayEnvelope,
} from '../index.js';
import { BaseRelayAdapter } from '../../base-adapter.js';
import type { DeliveryResult } from '../../types.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

class MinimalTestAdapter extends BaseRelayAdapter {
  constructor() {
    super('compliance-test', 'relay.test.compliance', 'Compliance Test');
  }

  protected async _start(): Promise<void> {
    /* no-op */
  }
  protected async _stop(): Promise<void> {
    /* no-op */
  }

  async deliver(_subject: string, _envelope: RelayEnvelope): Promise<DeliveryResult> {
    this.trackOutbound();
    return { success: true };
  }
}

// Run the actual compliance suite against a minimal adapter
runAdapterComplianceSuite({
  name: 'MinimalTestAdapter',
  createAdapter: () => new MinimalTestAdapter(),
  deliverSubject: 'relay.test.compliance.msg',
});

// Additional tests for mock utilities
describe('createMockRelayPublisher', () => {
  it('returns a publisher with publish and onSignal stubs', () => {
    const relay = createMockRelayPublisher();
    expect(typeof relay.publish).toBe('function');
    expect(typeof relay.onSignal).toBe('function');
  });

  it('publish() resolves with a default result', async () => {
    const relay = createMockRelayPublisher();
    const result = await relay.publish('relay.test.subject', {}, { from: 'test' });
    expect(result).toEqual({ messageId: 'test-msg-001', deliveredTo: 1 });
  });

  it('onSignal() returns an unsubscribe function', () => {
    const relay = createMockRelayPublisher();
    const unsub = relay.onSignal('relay.test.*', () => {});
    expect(typeof unsub).toBe('function');
  });
});

describe('createMockRelayEnvelope', () => {
  it('returns an envelope with default values', () => {
    const envelope = createMockRelayEnvelope();
    expect(envelope.id).toBe('test-envelope-001');
    expect(envelope.from).toBe('relay.test.sender');
    expect(envelope.subject).toBe('relay.test.recipient');
    expect(envelope.budget).toBeDefined();
    expect(envelope.createdAt).toBeDefined();
  });

  it('allows overriding defaults', () => {
    const envelope = createMockRelayEnvelope({ subject: 'custom.subject' });
    expect(envelope.subject).toBe('custom.subject');
    expect(envelope.id).toBe('test-envelope-001'); // non-overridden field preserved
  });

  it('returns a valid budget shape', () => {
    const envelope = createMockRelayEnvelope();
    expect(typeof envelope.budget.hopCount).toBe('number');
    expect(typeof envelope.budget.maxHops).toBe('number');
    expect(Array.isArray(envelope.budget.ancestorChain)).toBe(true);
    expect(typeof envelope.budget.ttl).toBe('number');
    expect(typeof envelope.budget.callBudgetRemaining).toBe('number');
  });
});
