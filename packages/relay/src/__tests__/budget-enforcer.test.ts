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

    it('rejects when TTL is exactly at current time — no time left is no time', () => {
      // The boundary is inclusive and shared: `isExpired` in `lib/envelope-ttl.ts`
      // answers it for this gate and for both delivery handlers, so a message
      // accepted here is a message one of them can still run. This gate used to
      // ask `Date.now() > ttl` on its own and admitted the exact millisecond the
      // handlers refuse — an envelope let through for a delivery that could not
      // happen (DOR-1770). The old test asserted that behaviour under a name
      // saying the opposite.
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);

      const envelope = makeEnvelope({ ttl: now });
      const result = enforceBudget(envelope, 'relay.endpoint.a');

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('ttl_expired');
    });
  });

  describe('call budget exhausted', () => {
    it('rejects when callBudgetRemaining is 0', () => {
      const envelope = makeEnvelope({ callBudgetRemaining: 0 });
      const result = enforceBudget(envelope, 'relay.endpoint.a');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('call budget exhausted');
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
