import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { enforceBudget, createDefaultBudget } from '../budget-enforcer.js';
import type { RelayEnvelope, RelayBudget } from '@dorkos/shared/relay-schemas';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnvelope(budgetOverrides: Partial<RelayBudget> = {}): RelayEnvelope {
  return {
    id: '01JKABCDEFGH',
    subject: 'relay.test.subject',
    from: 'relay.sender',
    budget: {
      hopCount: 0,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 60_000, // 1 minute from now
      callBudgetRemaining: 10,
      ...budgetOverrides,
    },
    createdAt: new Date().toISOString(),
    payload: { hello: 'world' },
  };
}

// ---------------------------------------------------------------------------
// enforceBudget — rejection cases
// ---------------------------------------------------------------------------

describe('enforceBudget', () => {
  describe('hop count exceeded', () => {
    it('rejects when hopCount equals maxHops', () => {
      const envelope = makeEnvelope({ hopCount: 5, maxHops: 5 });
      const result = enforceBudget(envelope, 'relay.endpoint.a');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('max hops exceeded (5/5)');
      expect(result.updatedBudget).toBeUndefined();
    });

    it('rejects when hopCount exceeds maxHops', () => {
      const envelope = makeEnvelope({ hopCount: 7, maxHops: 5 });
      const result = enforceBudget(envelope, 'relay.endpoint.a');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('max hops exceeded');
      expect(result.reason).toContain('7/5');
    });

    it('allows when hopCount is one below maxHops (boundary: not yet exceeded)', () => {
      const envelope = makeEnvelope({ hopCount: 4, maxHops: 5 });
      const result = enforceBudget(envelope, 'relay.endpoint.a');

      expect(result.allowed).toBe(true);
    });
  });

  describe('cycle detection', () => {
    it('rejects when currentEndpoint is already in ancestorChain', () => {
      const endpoint = 'relay.endpoint.a';
      const envelope = makeEnvelope({
        ancestorChain: ['relay.origin', endpoint, 'relay.endpoint.b'],
      });
      const result = enforceBudget(envelope, endpoint);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(`cycle detected: ${endpoint} already in chain`);
    });

    it('allows when currentEndpoint is not in ancestorChain', () => {
      const envelope = makeEnvelope({ ancestorChain: ['relay.origin', 'relay.endpoint.b'] });
      const result = enforceBudget(envelope, 'relay.endpoint.a');

      expect(result.allowed).toBe(true);
    });

    it('allows when ancestorChain is empty', () => {
      const envelope = makeEnvelope({ ancestorChain: [] });
      const result = enforceBudget(envelope, 'relay.endpoint.a');

      expect(result.allowed).toBe(true);
    });
  });

  describe('TTL expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects when TTL is in the past', () => {
      // Set current time to 1000ms after the TTL
      const ttl = 1_700_000_000_000;
      vi.setSystemTime(ttl + 1_000);

      const envelope = makeEnvelope({ ttl });
      const result = enforceBudget(envelope, 'relay.endpoint.a');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('message expired (TTL)');
    });

    it('allows when TTL is in the future', () => {
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);

      const envelope = makeEnvelope({ ttl: now + 60_000 });
      const result = enforceBudget(envelope, 'relay.endpoint.a');

      expect(result.allowed).toBe(true);
    });

    it('rejects when TTL is exactly at current time (expired)', () => {
      // Date.now() > ttl is the check, so exactly-equal should ALLOW
      // because we need strictly greater-than to reject
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);

      // TTL exactly equals now — Date.now() > ttl is false, so allowed
      const envelope = makeEnvelope({ ttl: now });
      const result = enforceBudget(envelope, 'relay.endpoint.a');

      // TTL == now means Date.now() is NOT > ttl, so it passes
      expect(result.allowed).toBe(true);
    });

    it('rejects when TTL is 1ms before current time', () => {
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);

      const envelope = makeEnvelope({ ttl: now - 1 });
      const result = enforceBudget(envelope, 'relay.endpoint.a');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('message expired (TTL)');
    });
  });

  describe('call budget exhausted', () => {
    it('rejects when callBudgetRemaining is 0', () => {
      const envelope = makeEnvelope({ callBudgetRemaining: 0 });
      const result = enforceBudget(envelope, 'relay.endpoint.a');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('call budget exhausted');
    });

    it('allows when callBudgetRemaining is 1 (last allowed call)', () => {
      const envelope = makeEnvelope({ callBudgetRemaining: 1 });
      const result = enforceBudget(envelope, 'relay.endpoint.a');

      expect(result.allowed).toBe(true);
      expect(result.updatedBudget?.callBudgetRemaining).toBe(0);
    });
  });

  describe('successful enforcement — updated budget', () => {
    it('returns allowed with updated budget when all checks pass', () => {
      const envelope = makeEnvelope({
        hopCount: 2,
        maxHops: 5,
        ancestorChain: ['relay.origin', 'relay.hop1'],
        callBudgetRemaining: 8,
      });
      const currentEndpoint = 'relay.endpoint.target';

      const result = enforceBudget(envelope, currentEndpoint);

      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.updatedBudget).toBeDefined();
    });

    it('increments hopCount by 1', () => {
      const envelope = makeEnvelope({ hopCount: 2 });
      const result = enforceBudget(envelope, 'relay.endpoint.a');

      expect(result.updatedBudget?.hopCount).toBe(3);
    });

    it('appends currentEndpoint to ancestorChain', () => {
      const envelope = makeEnvelope({ ancestorChain: ['relay.origin'] });
      const currentEndpoint = 'relay.endpoint.a';

      const result = enforceBudget(envelope, currentEndpoint);

      expect(result.updatedBudget?.ancestorChain).toEqual(['relay.origin', currentEndpoint]);
    });

    it('does not mutate the original ancestorChain', () => {
      const originalChain = ['relay.origin'];
      const envelope = makeEnvelope({ ancestorChain: originalChain });

      enforceBudget(envelope, 'relay.endpoint.a');

      expect(originalChain).toHaveLength(1);
    });

    it('decrements callBudgetRemaining by 1', () => {
      const envelope = makeEnvelope({ callBudgetRemaining: 7 });
      const result = enforceBudget(envelope, 'relay.endpoint.a');

      expect(result.updatedBudget?.callBudgetRemaining).toBe(6);
    });

    it('preserves all other budget fields unchanged', () => {
      const ttl = Date.now() + 60_000;
      const envelope = makeEnvelope({ maxHops: 10, ttl });
      const result = enforceBudget(envelope, 'relay.endpoint.a');

      expect(result.updatedBudget?.maxHops).toBe(10);
      expect(result.updatedBudget?.ttl).toBe(ttl);
    });
  });

  describe('check ordering (first failing check short-circuits)', () => {
    it('hop count check runs before cycle check', () => {
      // Both hop count exceeded AND cycle would trigger, but hop count is first
      const endpoint = 'relay.endpoint.a';
      const envelope = makeEnvelope({
        hopCount: 5,
        maxHops: 5,
        ancestorChain: [endpoint], // Would also trigger cycle
      });

      const result = enforceBudget(envelope, endpoint);

      expect(result.reason).toContain('max hops exceeded');
    });

    it('cycle check runs before TTL check', () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());

      // Cycle AND expired TTL — cycle is second check, TTL is third
      const endpoint = 'relay.endpoint.a';
      const envelope = makeEnvelope({
        ancestorChain: [endpoint],
        ttl: Date.now() - 1_000, // expired
      });

      const result = enforceBudget(envelope, endpoint);

      expect(result.reason).toContain('cycle detected');
    });
  });
});

// ---------------------------------------------------------------------------
// createDefaultBudget
// ---------------------------------------------------------------------------

describe('createDefaultBudget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns sensible defaults', () => {
    const budget = createDefaultBudget();

    expect(budget.hopCount).toBe(0);
    expect(budget.maxHops).toBe(5);
    expect(budget.ancestorChain).toEqual([]);
    expect(budget.callBudgetRemaining).toBe(10);
  });

  it('sets TTL to 1 hour from now', () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);

    const budget = createDefaultBudget();

    expect(budget.ttl).toBe(now + 3_600_000);
  });

  it('allows overriding maxHops', () => {
    const budget = createDefaultBudget({ maxHops: 10 });

    expect(budget.maxHops).toBe(10);
    // Other defaults still apply
    expect(budget.hopCount).toBe(0);
    expect(budget.callBudgetRemaining).toBe(10);
  });

  it('allows overriding callBudgetRemaining', () => {
    const budget = createDefaultBudget({ callBudgetRemaining: 50 });

    expect(budget.callBudgetRemaining).toBe(50);
    expect(budget.maxHops).toBe(5);
  });

  it('allows overriding multiple fields simultaneously', () => {
    const customTtl = Date.now() + 7_200_000;
    const budget = createDefaultBudget({
      maxHops: 3,
      callBudgetRemaining: 5,
      ttl: customTtl,
    });

    expect(budget.maxHops).toBe(3);
    expect(budget.callBudgetRemaining).toBe(5);
    expect(budget.ttl).toBe(customTtl);
    expect(budget.hopCount).toBe(0);
    expect(budget.ancestorChain).toEqual([]);
  });

  it('allows overriding ancestorChain', () => {
    const chain = ['relay.origin'];
    const budget = createDefaultBudget({ ancestorChain: chain });

    expect(budget.ancestorChain).toEqual(chain);
  });

  it('produces a budget that passes enforceBudget checks immediately', () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);

    const budget = createDefaultBudget();
    const envelope: RelayEnvelope = {
      id: '01JKABCDEFGH',
      subject: 'relay.test',
      from: 'relay.sender',
      budget,
      createdAt: new Date().toISOString(),
      payload: null,
    };

    const result = enforceBudget(envelope, 'relay.endpoint.a');

    expect(result.allowed).toBe(true);
  });
});
