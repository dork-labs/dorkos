import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseRelayAdapter } from '../base-adapter.js';
import type { RelayPublisher, DeliveryResult } from '../types.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

// === Concrete test subclass ===

class TestAdapter extends BaseRelayAdapter {
  startCalled = false;
  stopCalled = false;
  relayOnStart: RelayPublisher | null = null;

  constructor(shouldThrowOnStart = false) {
    super('test', 'relay.test.', 'Test');
    this._shouldThrowOnStart = shouldThrowOnStart;
  }

  private _shouldThrowOnStart: boolean;

  protected async _start(relay: RelayPublisher): Promise<void> {
    this.startCalled = true;
    this.relayOnStart = relay;
    if (this._shouldThrowOnStart) {
      throw new Error('Connection failed');
    }
  }

  protected async _stop(): Promise<void> {
    this.stopCalled = true;
  }

  async deliver(_subject: string, _envelope: RelayEnvelope): Promise<DeliveryResult> {
    this.trackOutbound();
    return { success: true };
  }

  // Expose protected helpers for testing
  callTrackInbound(): void { this.trackInbound(); }
  callRecordError(err: unknown): void { this.recordError(err); }
  getRelayRef(): RelayPublisher | null { return this.relay; }
}

function createMockRelay(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
  };
}

// === Tests ===

describe('BaseRelayAdapter', () => {
  let adapter: TestAdapter;
  let relay: RelayPublisher;

  beforeEach(() => {
    adapter = new TestAdapter();
    relay = createMockRelay();
  });

  // --- Initial state ---

  it('initial status is disconnected with zero counts', () => {
    const status = adapter.getStatus();
    expect(status.state).toBe('disconnected');
    expect(status.messageCount.inbound).toBe(0);
    expect(status.messageCount.outbound).toBe(0);
    expect(status.errorCount).toBe(0);
  });

  it('exposes id, subjectPrefix, and displayName from constructor', () => {
    expect(adapter.id).toBe('test');
    expect(adapter.subjectPrefix).toBe('relay.test.');
    expect(adapter.displayName).toBe('Test');
  });

  // --- start() ---

  it('start() calls _start() and transitions to connected', async () => {
    await adapter.start(relay);
    expect(adapter.startCalled).toBe(true);
    expect(adapter.getStatus().state).toBe('connected');
  });

  it('start() sets startedAt on the status', async () => {
    const before = new Date().toISOString();
    await adapter.start(relay);
    const { startedAt } = adapter.getStatus();
    expect(startedAt).toBeDefined();
    expect(startedAt! >= before).toBe(true);
  });

  it('start() stores the relay ref', async () => {
    await adapter.start(relay);
    expect(adapter.getRelayRef()).toBe(relay);
  });

  it('start() is idempotent — second call is a no-op', async () => {
    await adapter.start(relay);
    adapter.startCalled = false; // reset flag
    await adapter.start(relay); // second call
    expect(adapter.startCalled).toBe(false);
    expect(adapter.getStatus().state).toBe('connected');
  });

  it('start() error updates state to "error" and re-throws', async () => {
    const throwingAdapter = new TestAdapter(true);
    await expect(throwingAdapter.start(relay)).rejects.toThrow('Connection failed');
    expect(throwingAdapter.getStatus().state).toBe('error');
    expect(throwingAdapter.getStatus().errorCount).toBe(1);
    expect(throwingAdapter.getStatus().lastError).toBe('Connection failed');
  });

  it('start() clears relay ref when _start() throws', async () => {
    const throwingAdapter = new TestAdapter(true);
    await expect(throwingAdapter.start(relay)).rejects.toThrow();
    expect(throwingAdapter.getRelayRef()).toBeNull();
  });

  // --- stop() ---

  it('stop() calls _stop() and transitions to disconnected', async () => {
    await adapter.start(relay);
    await adapter.stop();
    expect(adapter.stopCalled).toBe(true);
    expect(adapter.getStatus().state).toBe('disconnected');
  });

  it('stop() clears the relay ref', async () => {
    await adapter.start(relay);
    await adapter.stop();
    expect(adapter.getRelayRef()).toBeNull();
  });

  it('stop() is idempotent — second call is a no-op', async () => {
    await adapter.start(relay);
    await adapter.stop();
    adapter.stopCalled = false; // reset flag
    await adapter.stop(); // second call
    expect(adapter.stopCalled).toBe(false);
  });

  it('stop() without start() does not throw', async () => {
    await expect(adapter.stop()).resolves.toBeUndefined();
  });

  it('stop() clears relay ref in finally even if _stop() throws', async () => {
    class ThrowingStopAdapter extends BaseRelayAdapter {
      constructor() { super('t', 'relay.t.', 'T'); }
      protected async _start(): Promise<void> {}
      protected async _stop(): Promise<void> { throw new Error('stop failed'); }
      async deliver(): Promise<DeliveryResult> { return { success: true }; }
      getRelayRefPublic(): RelayPublisher | null { return this.relay; }
    }
    const a = new ThrowingStopAdapter();
    await a.start(relay);
    // stop() uses finally — relay ref is cleared even when _stop() throws
    await expect(a.stop()).rejects.toThrow('stop failed');
    expect(a.getRelayRefPublic()).toBeNull();
    // State is also set to disconnected
    expect(a.getStatus().state).toBe('disconnected');
  });

  // --- trackOutbound() / trackInbound() ---

  it('deliver() calling trackOutbound() increments outbound count', async () => {
    await adapter.start(relay);
    const envelope = {
      id: 'e1', subject: 'relay.test.sub', from: 'relay.test.sender',
      payload: {}, budget: { hopCount: 0, maxHops: 5, ancestorChain: [], ttl: Date.now() + 1000, callBudgetRemaining: 5 },
      createdAt: new Date().toISOString(),
    };
    await adapter.deliver('relay.test.sub', envelope);
    expect(adapter.getStatus().messageCount.outbound).toBe(1);
  });

  it('trackInbound() increments inbound count', () => {
    adapter.callTrackInbound();
    adapter.callTrackInbound();
    expect(adapter.getStatus().messageCount.inbound).toBe(2);
  });

  // --- recordError() ---

  it('recordError() sets state to "error" and increments errorCount', () => {
    adapter.callRecordError(new Error('Oops'));
    const status = adapter.getStatus();
    expect(status.state).toBe('error');
    expect(status.errorCount).toBe(1);
    expect(status.lastError).toBe('Oops');
    expect(status.lastErrorAt).toBeDefined();
  });

  it('recordError() accepts non-Error values', () => {
    adapter.callRecordError('string error');
    expect(adapter.getStatus().lastError).toBe('string error');
  });

  it('recordError() accumulates multiple errors', () => {
    adapter.callRecordError(new Error('First'));
    adapter.callRecordError(new Error('Second'));
    expect(adapter.getStatus().errorCount).toBe(2);
    expect(adapter.getStatus().lastError).toBe('Second');
  });

  // --- getStatus() ---

  it('getStatus() returns a copy — mutations do not affect internal state', async () => {
    await adapter.start(relay);
    const status = adapter.getStatus();
    // Mutate the returned copy
    status.errorCount = 999;
    status.state = 'error';
    // Internal state should be unchanged
    expect(adapter.getStatus().errorCount).toBe(0);
    expect(adapter.getStatus().state).toBe('connected');
  });

  it('getStatus() returns distinct objects on each call', () => {
    const s1 = adapter.getStatus();
    const s2 = adapter.getStatus();
    expect(s1).not.toBe(s2);
  });
});
