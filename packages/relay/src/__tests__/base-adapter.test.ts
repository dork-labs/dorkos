import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockRelay } from './fixtures.js';
import { BaseRelayAdapter } from '../base-adapter.js';
import type { RelayPublisher, RelayLogger, DeliveryResult } from '../types.js';
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
  callTrackInbound(): void {
    this.trackInbound();
  }
  callRecordError(err: unknown): void {
    this.recordError(err);
  }
  callSetReconnecting(): void {
    this.setReconnecting();
  }
  callMarkConnected(): void {
    this.markConnected();
  }
  callIsStopped(): boolean {
    return this.isStopped;
  }
  getRelayRef(): RelayPublisher | null {
    return this.relay;
  }
  callMakeInboundCallbacks() {
    return this.makeInboundCallbacks();
  }
  callMakeOutboundCallbacks() {
    return this.makeOutboundCallbacks();
  }
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

  // --- start() ---

  it('start() calls _start() and transitions to connected', async () => {
    await adapter.start(relay);
    expect(adapter.startCalled).toBe(true);
    expect(adapter.getStatus().state).toBe('connected');
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

  it('start() concurrent calls run _start() only once (no double polling)', async () => {
    let startCount = 0;
    let resolveStart!: () => void;
    class SlowAdapter extends BaseRelayAdapter {
      constructor() {
        super('slow', 'relay.slow.', 'Slow');
      }
      protected async _start(): Promise<void> {
        startCount++;
        await new Promise<void>((resolve) => {
          resolveStart = resolve;
        });
      }
      protected async _stop(): Promise<void> {}
      async deliver(): Promise<DeliveryResult> {
        return { success: true };
      }
    }
    const a = new SlowAdapter();

    const p1 = a.start(relay);
    const p2 = a.start(relay); // concurrent — must await the same in-flight attempt
    expect(startCount).toBe(1);
    expect(a.getStatus().state).toBe('starting');

    resolveStart();
    await Promise.all([p1, p2]);

    expect(startCount).toBe(1);
    expect(a.getStatus().state).toBe('connected');
  });

  it('stop() during in-flight start() stays disconnected — no late connected flip', async () => {
    let resolveStart!: () => void;
    let stopCount = 0;
    class SlowStartAdapter extends BaseRelayAdapter {
      constructor() {
        super('ss', 'relay.ss.', 'SS');
      }
      protected async _start(): Promise<void> {
        await new Promise<void>((resolve) => {
          resolveStart = resolve;
        });
      }
      protected async _stop(): Promise<void> {
        stopCount++;
      }
      async deliver(): Promise<DeliveryResult> {
        return { success: true };
      }
      getRelayRefPublic(): RelayPublisher | null {
        return this.relay;
      }
    }
    const a = new SlowStartAdapter();

    const startPromise = a.start(relay);
    expect(a.getStatus().state).toBe('starting');

    // stop() intervenes while _start() is still hung — this is exactly what
    // the registry's start-timeout path does.
    await a.stop();
    expect(a.getStatus().state).toBe('disconnected');
    expect(stopCount).toBe(1);

    // The hung _start() finally resolves. The adapter must NOT flip to
    // 'connected' (that would be a connected state with relay=null and an
    // unmanaged connection); late-wired resources are torn down instead.
    resolveStart();
    await startPromise;

    expect(a.getStatus().state).toBe('disconnected');
    expect(stopCount).toBe(2); // second _stop() tears down what the late _start() wired
    expect(a.getRelayRefPublic()).toBeNull();
  });

  /**
   * DOR-1509. The OTHER cleanup `_stop()` call site — the one that runs when
   * `stop()` intervenes during an in-flight `start()`, not the one that runs
   * when `_start()` itself throws (covered separately below). Same
   * nested-secret risk, same fix (`describeError`), different call site —
   * proven here rather than assumed from the sibling test.
   */
  it('the intervening-stop cleanup _stop() failure never lets a nested secret reach the logger', async () => {
    const secret = 'intervening-secret-token-value';
    class PoisonedError extends Error {
      readonly config = { headers: { Authorization: `Bearer ${secret}` } };
      toJSON() {
        return { message: this.message, config: this.config };
      }
    }
    let resolveStart!: () => void;
    let stopCalls = 0;
    class SlowStartPoisonedCleanupAdapter extends BaseRelayAdapter {
      constructor() {
        super('sspc', 'relay.sspc.', 'SSPC');
      }
      protected async _start(): Promise<void> {
        await new Promise<void>((resolve) => {
          resolveStart = resolve;
        });
      }
      protected async _stop(): Promise<void> {
        stopCalls++;
        // The FIRST call is the direct `a.stop()` below, driven the same way
        // as the sibling test — it must succeed so `isStopped` reads true and
        // the late `_start()` takes the intervening-cleanup branch. The
        // SECOND call is that branch's own cleanup `_stop()`, which is the
        // one whose failure this test is actually about.
        if (stopCalls > 1) throw new PoisonedError('intervening cleanup stop failed');
      }
      async deliver(): Promise<DeliveryResult> {
        return { success: true };
      }
    }
    const a = new SlowStartPoisonedCleanupAdapter();
    const logger: RelayLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    a.setLogger(logger);

    const startPromise = a.start(relay);
    await a.stop(); // first _stop() succeeds; state -> disconnected, isStopped -> true

    resolveStart(); // the hung _start() finally resolves
    await startPromise; // _runStart sees isStopped, runs cleanup _stop() (2nd call) -> throws

    const everyLoggedArg = [
      ...vi.mocked(logger.debug).mock.calls,
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
    ];
    const serialized = JSON.stringify(everyLoggedArg);
    expect(serialized).not.toContain(secret);
    // Sanity check the assertion isn't vacuous: the safe part of the same
    // failure is still logged somewhere.
    expect(serialized).toContain('intervening cleanup stop failed');
  });

  it('start() attempts _stop() cleanup when _start() throws', async () => {
    let stopCalled = false;
    class FailStartAdapter extends BaseRelayAdapter {
      constructor() {
        super('fs', 'relay.fs.', 'FS');
      }
      protected async _start(): Promise<void> {
        throw new Error('connect boom');
      }
      protected async _stop(): Promise<void> {
        stopCalled = true;
      }
      async deliver(): Promise<DeliveryResult> {
        return { success: true };
      }
    }
    const a = new FailStartAdapter();

    await expect(a.start(relay)).rejects.toThrow('connect boom');
    // Cleanup runs so partially-wired resources (subscriptions, timers) don't leak.
    expect(stopCalled).toBe(true);
    expect(a.getStatus().state).toBe('error');
  });

  it('start() surfaces the original _start() error even if cleanup _stop() throws', async () => {
    class BothThrowAdapter extends BaseRelayAdapter {
      constructor() {
        super('bt', 'relay.bt.', 'BT');
      }
      protected async _start(): Promise<void> {
        throw new Error('start failed');
      }
      protected async _stop(): Promise<void> {
        throw new Error('stop failed');
      }
      async deliver(): Promise<DeliveryResult> {
        return { success: true };
      }
    }
    const a = new BothThrowAdapter();

    await expect(a.start(relay)).rejects.toThrow('start failed');
    expect(a.getStatus().state).toBe('error');
  });

  /**
   * DOR-1509. The cleanup `_stop()` a failed `start()` runs is shared by
   * every adapter (Slack, Telegram, whatever comes next) — whatever their
   * own `_stop()` throws (a dead HTTP client tearing down, say) can carry
   * the same nested-secret shape Slack's and Telegram's SDKs do. This
   * reproduces the axios shape (a `toJSON()` that serializes a header) at
   * the base-class level, since the leak mechanism, not the SDK, is what
   * this cleanup path is responsible for never exposing.
   */
  it('start() cleanup _stop() failure never lets a nested secret reach the logger', async () => {
    const secret = 'super-secret-token-value';
    class PoisonedError extends Error {
      readonly config = { headers: { Authorization: `Bearer ${secret}` } };
      toJSON() {
        return { message: this.message, config: this.config };
      }
    }
    class BothThrowPoisonedAdapter extends BaseRelayAdapter {
      constructor() {
        super('btp', 'relay.btp.', 'BTP');
      }
      protected async _start(): Promise<void> {
        throw new Error('start failed');
      }
      protected async _stop(): Promise<void> {
        throw new PoisonedError('stop failed');
      }
      async deliver(): Promise<DeliveryResult> {
        return { success: true };
      }
    }
    const a = new BothThrowPoisonedAdapter();
    const logger: RelayLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    a.setLogger(logger);

    await expect(a.start(relay)).rejects.toThrow('start failed');

    // Load-bearing: scans every argument ever handed to every logger method,
    // stringified — the same way a regression back to
    // `logger.warn('...', stopErr)` would actually surface the leak, since
    // `JSON.stringify` invokes a nested `toJSON()` exactly like axios's does.
    const everyLoggedArg = [
      ...vi.mocked(logger.debug).mock.calls,
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
    ];
    const serialized = JSON.stringify(everyLoggedArg);
    expect(serialized).not.toContain(secret);
    // Sanity check the assertion isn't vacuous: the safe part of the same
    // failure is still logged somewhere.
    expect(serialized).toContain('stop failed');
  });

  it('start() can be retried after a failed attempt', async () => {
    let attempts = 0;
    class FlakyAdapter extends BaseRelayAdapter {
      constructor() {
        super('flaky', 'relay.flaky.', 'Flaky');
      }
      protected async _start(): Promise<void> {
        attempts++;
        if (attempts === 1) throw new Error('first attempt fails');
      }
      protected async _stop(): Promise<void> {}
      async deliver(): Promise<DeliveryResult> {
        return { success: true };
      }
    }
    const a = new FlakyAdapter();

    await expect(a.start(relay)).rejects.toThrow('first attempt fails');
    await a.start(relay); // second attempt succeeds — guard cleared after failure
    expect(attempts).toBe(2);
    expect(a.getStatus().state).toBe('connected');
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

  it('stop() that throws clears the relay ref and reports the adapter as errored', async () => {
    class ThrowingStopAdapter extends BaseRelayAdapter {
      constructor() {
        super('t', 'relay.t.', 'T');
      }
      protected async _start(): Promise<void> {}
      protected async _stop(): Promise<void> {
        throw new Error('stop failed');
      }
      async deliver(): Promise<DeliveryResult> {
        return { success: true };
      }
      getRelayRefPublic(): RelayPublisher | null {
        return this.relay;
      }
    }
    const a = new ThrowingStopAdapter();
    await a.start(relay);
    await expect(a.stop()).rejects.toThrow('stop failed');
    expect(a.getRelayRefPublic()).toBeNull();
    // NOT 'disconnected'. An adapter whose stop threw may still be holding its
    // connection, and reporting it cleanly stopped is what let the registry
    // start a second one on the same credentials (DOR-789).
    expect(a.getStatus().state).toBe('error');
    expect(a.getStatus().lastError).toBe('stop failed');
  });

  // --- trackOutbound() / trackInbound() ---

  it('deliver() calling trackOutbound() increments outbound count', async () => {
    await adapter.start(relay);
    const envelope = {
      id: 'e1',
      subject: 'relay.test.sub',
      from: 'relay.test.sender',
      payload: {},
      budget: {
        hopCount: 0,
        maxHops: 5,
        ancestorChain: [],
        ttl: Date.now() + 1000,
        callBudgetRemaining: 5,
      },
      createdAt: new Date().toISOString(),
    };
    await adapter.deliver('relay.test.sub', envelope);
    expect(adapter.getStatus().messageCount.outbound).toBe(1);
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

  // --- getStatus() ---

  // --- setReconnecting() ---

  it('setReconnecting() transitions from error to reconnecting', () => {
    adapter.callRecordError(new Error('Connection lost'));
    expect(adapter.getStatus().state).toBe('error');

    adapter.callSetReconnecting();
    expect(adapter.getStatus().state).toBe('reconnecting');
  });

  // --- markConnected() ---

  it('markConnected() transitions from reconnecting to connected', () => {
    adapter.callRecordError(new Error('err'));
    adapter.callSetReconnecting();
    expect(adapter.getStatus().state).toBe('reconnecting');

    adapter.callMarkConnected();
    expect(adapter.getStatus().state).toBe('connected');
  });

  // --- isStopped ---

  // --- stop() clears startedAt ---

  // --- makeInboundCallbacks() ---

  // --- makeOutboundCallbacks() ---
});
