import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeliveryPipeline } from '../delivery-pipeline.js';
import type { DeliveryPipelineDeps, EndpointDeliveryResult } from '../delivery-pipeline.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { EndpointInfo, BackpressureConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDeps(): DeliveryPipelineDeps {
  return {
    sqliteIndex: {
      countNewByEndpoint: vi.fn().mockReturnValue(0),
      insertMessage: vi.fn(),
      updateStatus: vi.fn(),
    } as unknown as DeliveryPipelineDeps['sqliteIndex'],
    maildirStore: {
      deliver: vi.fn().mockResolvedValue({ ok: true, messageId: 'msg-001' }),
      claim: vi.fn().mockResolvedValue({ ok: true, envelope: {} }),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    } as unknown as DeliveryPipelineDeps['maildirStore'],
    subscriptionRegistry: {
      getSubscribers: vi.fn().mockReturnValue([]),
    } as unknown as DeliveryPipelineDeps['subscriptionRegistry'],
    circuitBreaker: {
      check: vi.fn().mockReturnValue({ allowed: true }),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    } as unknown as DeliveryPipelineDeps['circuitBreaker'],
    signalEmitter: {
      emit: vi.fn(),
    } as unknown as DeliveryPipelineDeps['signalEmitter'],
    deadLetterQueue: {
      reject: vi.fn().mockResolvedValue(undefined),
    } as unknown as DeliveryPipelineDeps['deadLetterQueue'],
  };
}

const defaultBpConfig: BackpressureConfig = {
  enabled: true,
  maxMailboxSize: 1000,
  pressureWarningAt: 0.8,
};

function createEnvelope(overrides?: Partial<RelayEnvelope>): RelayEnvelope {
  return {
    id: 'test-id',
    subject: 'relay.agent.test',
    from: 'relay.agent.sender',
    budget: {
      maxHops: 5,
      hopCount: 0,
      ttl: Date.now() + 3_600_000,
      callBudgetRemaining: 10,
      ancestorChain: [],
    },
    createdAt: new Date().toISOString(),
    payload: { hello: 'world' },
    ...overrides,
  };
}

function createEndpoint(overrides?: Partial<EndpointInfo>): EndpointInfo {
  return {
    subject: 'relay.agent.test',
    hash: 'hash-001',
    maildirPath: '/tmp/test/mailboxes/hash-001',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeliveryPipeline', () => {
  let deps: DeliveryPipelineDeps;
  let pipeline: DeliveryPipeline;

  beforeEach(() => {
    deps = createMockDeps();
    pipeline = new DeliveryPipeline(deps, defaultBpConfig);
  });

  describe('deliverToEndpoint', () => {
    it('delivers successfully when all checks pass', async () => {
      const endpoint = createEndpoint();
      const envelope = createEnvelope();

      const result = await pipeline.deliverToEndpoint(endpoint, envelope);

      expect(result.delivered).toBe(true);
      expect(result.rejected).toBeUndefined();
      expect(deps.maildirStore.deliver).toHaveBeenCalledWith(endpoint.hash, expect.any(Object));
      expect(deps.circuitBreaker.recordSuccess).toHaveBeenCalledWith(endpoint.hash);
      expect(deps.sqliteIndex.insertMessage).toHaveBeenCalled();
    });

    it('rejects when backpressure is exceeded', async () => {
      vi.mocked(deps.sqliteIndex.countNewByEndpoint).mockReturnValue(1000);
      const endpoint = createEndpoint();
      const envelope = createEnvelope();

      const result = await pipeline.deliverToEndpoint(endpoint, envelope);

      expect(result.delivered).toBe(false);
      expect(result.rejected?.reason).toBe('backpressure');
      expect(deps.maildirStore.deliver).not.toHaveBeenCalled();
    });

    it('emits backpressure warning signal at warning threshold', async () => {
      vi.mocked(deps.sqliteIndex.countNewByEndpoint).mockReturnValue(800);
      const endpoint = createEndpoint();
      const envelope = createEnvelope();

      await pipeline.deliverToEndpoint(endpoint, envelope);

      expect(deps.signalEmitter.emit).toHaveBeenCalledWith(
        endpoint.subject,
        expect.objectContaining({ type: 'backpressure', state: 'warning' }),
      );
    });

    it('rejects when circuit breaker is open', async () => {
      vi.mocked(deps.circuitBreaker.check).mockReturnValue({ allowed: false });
      const endpoint = createEndpoint();
      const envelope = createEnvelope();

      const result = await pipeline.deliverToEndpoint(endpoint, envelope);

      expect(result.delivered).toBe(false);
      expect(result.rejected?.reason).toBe('circuit_open');
    });

    it('rejects to DLQ when budget is exceeded', async () => {
      const endpoint = createEndpoint();
      const envelope = createEnvelope({
        budget: { maxHops: 5, hopCount: 6, ttl: Date.now() + 3_600_000, callBudgetRemaining: 10, ancestorChain: [] },
      });

      const result = await pipeline.deliverToEndpoint(endpoint, envelope);

      expect(result.delivered).toBe(false);
      expect(result.rejected?.reason).toBe('budget_exceeded');
      expect(deps.deadLetterQueue.reject).toHaveBeenCalled();
    });

    it('records circuit breaker failure when maildir delivery fails', async () => {
      vi.mocked(deps.maildirStore.deliver).mockResolvedValue({
        ok: false,
        error: 'disk full',
      });
      const endpoint = createEndpoint();
      const envelope = createEnvelope();

      const result = await pipeline.deliverToEndpoint(endpoint, envelope);

      expect(result.delivered).toBe(false);
      expect(deps.circuitBreaker.recordFailure).toHaveBeenCalledWith(endpoint.hash);
    });

    it('includes pressure in result', async () => {
      const endpoint = createEndpoint();
      const envelope = createEnvelope();

      const result = await pipeline.deliverToEndpoint(endpoint, envelope);

      expect(result.pressure).toBeDefined();
      expect(typeof result.pressure).toBe('number');
    });
  });

  describe('dispatchToSubscribers', () => {
    it('claims, invokes handlers, and completes on success', async () => {
      const handler = vi.fn();
      vi.mocked(deps.subscriptionRegistry.getSubscribers).mockReturnValue([handler]);
      vi.mocked(deps.maildirStore.claim).mockResolvedValue({
        ok: true,
        envelope: { subject: 'test' },
      });

      const endpoint = createEndpoint();
      await pipeline.dispatchToSubscribers(endpoint, 'msg-001', createEnvelope());

      expect(deps.maildirStore.claim).toHaveBeenCalledWith(endpoint.hash, 'msg-001');
      expect(handler).toHaveBeenCalled();
      expect(deps.maildirStore.complete).toHaveBeenCalledWith(endpoint.hash, 'msg-001');
      expect(deps.sqliteIndex.updateStatus).toHaveBeenCalledWith('msg-001', 'delivered');
    });

    it('moves to failed and records CB failure when handler throws', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('handler boom'));
      vi.mocked(deps.subscriptionRegistry.getSubscribers).mockReturnValue([handler]);
      vi.mocked(deps.maildirStore.claim).mockResolvedValue({
        ok: true,
        envelope: { subject: 'test' },
      });

      const endpoint = createEndpoint();
      await pipeline.dispatchToSubscribers(endpoint, 'msg-001', createEnvelope());

      expect(deps.maildirStore.fail).toHaveBeenCalledWith(endpoint.hash, 'msg-001', 'handler boom');
      expect(deps.sqliteIndex.updateStatus).toHaveBeenCalledWith('msg-001', 'failed');
      expect(deps.circuitBreaker.recordFailure).toHaveBeenCalledWith(endpoint.hash);
    });

    it('skips dispatch when no subscribers match', async () => {
      vi.mocked(deps.subscriptionRegistry.getSubscribers).mockReturnValue([]);

      await pipeline.dispatchToSubscribers(createEndpoint(), 'msg-001', createEnvelope());

      expect(deps.maildirStore.claim).not.toHaveBeenCalled();
    });

    it('skips dispatch when claim fails', async () => {
      vi.mocked(deps.subscriptionRegistry.getSubscribers).mockReturnValue([vi.fn()]);
      vi.mocked(deps.maildirStore.claim).mockResolvedValue({ ok: false });

      await pipeline.dispatchToSubscribers(createEndpoint(), 'msg-001', createEnvelope());

      expect(deps.maildirStore.complete).not.toHaveBeenCalled();
    });
  });

  describe('setBackpressureConfig', () => {
    it('updates the backpressure config', async () => {
      // Lower the threshold so 5 messages trigger rejection
      pipeline.setBackpressureConfig({ enabled: true, maxMailboxSize: 5, pressureWarningAt: 0.5 });
      vi.mocked(deps.sqliteIndex.countNewByEndpoint).mockReturnValue(5);

      const result = await pipeline.deliverToEndpoint(createEndpoint(), createEnvelope());

      expect(result.delivered).toBe(false);
      expect(result.rejected?.reason).toBe('backpressure');
    });
  });
});
