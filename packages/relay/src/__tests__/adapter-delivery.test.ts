import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AdapterDelivery } from '../adapter-delivery.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { AdapterRegistryLike, DeliveryResult } from '../types.js';
import type { SqliteIndex } from '../sqlite-index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function createMockAdapterRegistry(): AdapterRegistryLike {
  return {
    deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 100 } as DeliveryResult),
    setRelay: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockSqliteIndex(): SqliteIndex {
  return {
    insertMessage: vi.fn(),
  } as unknown as SqliteIndex;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdapterDelivery', () => {
  let adapterRegistry: AdapterRegistryLike;
  let sqliteIndex: SqliteIndex;

  beforeEach(() => {
    adapterRegistry = createMockAdapterRegistry();
    sqliteIndex = createMockSqliteIndex();
  });

  describe('deliver', () => {
    it('returns null when no adapter registry is configured', async () => {
      const delivery = new AdapterDelivery(undefined, sqliteIndex);
      const result = await delivery.deliver('relay.agent.test', createEnvelope());
      expect(result).toBeNull();
    });

    it('delivers successfully and indexes in SQLite', async () => {
      const delivery = new AdapterDelivery(adapterRegistry, sqliteIndex);
      const envelope = createEnvelope();

      const result = await delivery.deliver('relay.agent.test', envelope);

      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
      expect(adapterRegistry.deliver).toHaveBeenCalledWith(
        'relay.agent.test',
        envelope,
        undefined,
      );
      expect(sqliteIndex.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: envelope.id,
          subject: 'relay.agent.test',
          status: 'delivered',
        }),
      );
    });

    it('does not index when delivery fails', async () => {
      vi.mocked(adapterRegistry.deliver).mockResolvedValue({
        success: false,
        error: 'adapter error',
      } as DeliveryResult);
      const delivery = new AdapterDelivery(adapterRegistry, sqliteIndex);

      const result = await delivery.deliver('relay.agent.test', createEnvelope());

      expect(result!.success).toBe(false);
      expect(sqliteIndex.insertMessage).not.toHaveBeenCalled();
    });

    it('handles adapter errors gracefully', async () => {
      vi.mocked(adapterRegistry.deliver).mockRejectedValue(new Error('network error'));
      const logger = { warn: vi.fn() };
      const delivery = new AdapterDelivery(adapterRegistry, sqliteIndex, logger);

      const result = await delivery.deliver('relay.agent.test', createEnvelope());

      expect(result).toEqual({
        success: false,
        error: 'network error',
        deadLettered: false,
        durationMs: undefined,
      });
      expect(logger.warn).toHaveBeenCalledWith(
        'RelayCore: adapter delivery failed:',
        'network error',
      );
    });

    it('uses injected logger instead of console (I3 fix)', async () => {
      vi.mocked(adapterRegistry.deliver).mockRejectedValue(new Error('fail'));
      const logger = { warn: vi.fn() };
      const delivery = new AdapterDelivery(adapterRegistry, sqliteIndex, logger);

      await delivery.deliver('relay.agent.test', createEnvelope());

      expect(logger.warn).toHaveBeenCalled();
    });

    it('clears timeout timer on success (I1 fix — no timer leak)', async () => {
      // The timer leak fix is structural: finally { clearTimeout(timer!) }
      // We verify by ensuring a successful delivery doesn't leave pending timers
      const delivery = new AdapterDelivery(adapterRegistry, sqliteIndex);
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      await delivery.deliver('relay.agent.test', createEnvelope());

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    it('clears timeout timer on error (I1 fix — no timer leak)', async () => {
      vi.mocked(adapterRegistry.deliver).mockRejectedValue(new Error('fail'));
      const logger = { warn: vi.fn() };
      const delivery = new AdapterDelivery(adapterRegistry, sqliteIndex, logger);
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      await delivery.deliver('relay.agent.test', createEnvelope());

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    it('times out after TIMEOUT_MS', async () => {
      vi.useFakeTimers();
      vi.mocked(adapterRegistry.deliver).mockReturnValue(
        new Promise(() => {
          // Never resolves
        }),
      );
      const logger = { warn: vi.fn() };
      const delivery = new AdapterDelivery(adapterRegistry, sqliteIndex, logger);

      const promise = delivery.deliver('relay.agent.test', createEnvelope());
      vi.advanceTimersByTime(AdapterDelivery.TIMEOUT_MS);

      const result = await promise;
      expect(result!.success).toBe(false);
      expect(result!.error).toContain('timeout');

      vi.useRealTimers();
    });

    it('passes context from contextBuilder', async () => {
      const delivery = new AdapterDelivery(adapterRegistry, sqliteIndex);
      const contextBuilder = vi.fn().mockReturnValue({ agentCwd: '/test' });

      await delivery.deliver('relay.agent.test', createEnvelope(), contextBuilder);

      expect(contextBuilder).toHaveBeenCalledWith('relay.agent.test');
      expect(adapterRegistry.deliver).toHaveBeenCalledWith(
        'relay.agent.test',
        expect.any(Object),
        { agentCwd: '/test' },
      );
    });
  });
});
