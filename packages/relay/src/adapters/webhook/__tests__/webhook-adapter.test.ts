import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockRelay } from '../../../__tests__/fixtures.js';
import { WEBHOOK_SERVER_SUBJECT_REFUSAL } from '@dorkos/shared/relay-schemas';
import { WebhookAdapter } from '../webhook-adapter.js';
import { runAdapterComplianceSuite } from '../../../testing/index.js';
import type { RelayPublisher } from '../../../types.js';
import { AdapterRegistry } from '../../../adapter-registry.js';

import { SECRET, OUTBOUND_URL, buildHeaders, makeAdapter } from './webhook-adapter.fixtures.js';

describe('WebhookAdapter', () => {
  let adapter: WebhookAdapter;
  let relay: RelayPublisher;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-24T12:00:00.000Z'));
    adapter = makeAdapter();
    relay = createMockRelay();
  });

  afterEach(async () => {
    await adapter.stop();
    vi.useRealTimers();
  });

  describe('stop()', () => {
    it('clears the nonce map', async () => {
      await adapter.start(relay);

      const body = '{"event":"test"}';
      const headers = buildHeaders(body, SECRET);
      await adapter.handleInbound(Buffer.from(body), headers);

      await adapter.stop();

      // After stop + restart, the same nonce should be accepted again
      await adapter.start(createMockRelay());
      const result = await adapter.handleInbound(Buffer.from(body), headers);
      expect(result.ok).toBe(true);
    });
  });

  // --- inbound HMAC verification ---

  // Constructor calls can bypass schema/loading checks; runtime effects must
  // still refuse persisted addresses outside the literal webhook namespace.
  describe.each([
    'relay.system.tasks.task-1',
    'relay.agent.codex.session',
    'relay.human.console',
    'relay.inbox.owner',
    'relay.doc.canvas-hash',
    'relay.webhook.*',
    'relay.webhook.x..y',
  ])('a persisted config aimed at %s', (inboundSubject) => {
    const legacy = () => makeAdapter({ inboundSubject });

    it('refuses to start, naming the rule', async () => {
      const refused = legacy();
      await expect(refused.start(relay)).rejects.toThrow(WEBHOOK_SERVER_SUBJECT_REFUSAL);
      expect(refused.getStatus().state).not.toBe('connected');
    });

    it('refuses a signed inbound request without publishing', async () => {
      const refused = legacy();
      const body = '{"type":"task_dispatch"}';
      const result = await refused.handleInbound(Buffer.from(body), buildHeaders(body, SECRET));
      expect(result).toEqual({ ok: false, error: WEBHOOK_SERVER_SUBJECT_REFUSAL, status: 403 });
      expect(relay.publish).not.toHaveBeenCalled();
    });

    it('refuses to forward the server traffic it matches to the outbound URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);
      const result = await legacy().deliver('relay.system.tasks.task-1', {
        id: 'env-01',
        subject: 'relay.system.tasks.task-1',
        from: 'relay.system.tasks.scheduler',
        budget: {
          hopCount: 0,
          maxHops: 5,
          ancestorChain: [],
          ttl: Date.now() + 3600000,
          callBudgetRemaining: 10,
        },
        createdAt: new Date().toISOString(),
        payload: { prompt: 'secret schedule prompt' },
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe(WEBHOOK_SERVER_SUBJECT_REFUSAL);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('keeps a real signed webhook connected when its active instance is registered twice', async () => {
    const registry = new AdapterRegistry();
    registry.setRelay(relay);
    registry.setLogger({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
    const start = vi.spyOn(adapter, 'start'),
      stop = vi.spyOn(adapter, 'stop');
    await registry.register(adapter);
    await registry.register(adapter);
    expect(registry.get(adapter.id)).toBe(adapter);
    expect(registry.getBySubject('relay.webhook.test.child')).toBe(adapter);
    expect(adapter.getStatus().state).toBe('connected');
    expect(start).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    const body = '{"event":"same-active-instance"}';
    expect(
      await adapter.handleInbound(Buffer.from(body), buildHeaders(body, SECRET))
    ).toMatchObject({ ok: true });
    expect(relay.publish).toHaveBeenCalledOnce();
    expect(relay.publish).toHaveBeenCalledWith(
      'relay.webhook.test',
      expect.objectContaining({ data: JSON.parse(body) }),
      { from: 'relay.webhook.test-webhook' }
    );
  });

  it.each(['relay.webhook.GitHub.alerts_1', 'relay.webhook.x', 'relay.webhook.x2'])(
    'starts and verifies inbound and outbound HMAC at the valid address %s',
    async (subject) => {
      const valid = makeAdapter({ inboundSubject: subject });
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);
      try {
        await valid.start(relay);
        expect(valid.getStatus().state).toBe('connected');
        const body = '{"event":"push","ref":"refs/heads/main"}';
        expect(
          await valid.handleInbound(Buffer.from(body), buildHeaders(body, SECRET))
        ).toMatchObject({ ok: true });
        expect(relay.publish).toHaveBeenCalledWith(
          subject,
          expect.objectContaining({ data: JSON.parse(body) }),
          { from: 'relay.webhook.test-webhook' }
        );
        const payload = { text: 'valid namespace outbound' };
        const result = await valid.deliver(subject, {
          id: 'valid-namespace-envelope',
          subject,
          from: 'relay.agent.sender',
          budget: {
            hopCount: 0,
            maxHops: 5,
            ancestorChain: [],
            ttl: Date.now() + 3600000,
            callBudgetRemaining: 10,
          },
          createdAt: new Date().toISOString(),
          payload,
        });
        expect(result.success).toBe(true);
        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, options] = fetchMock.mock.calls[0] as [
          string,
          RequestInit & { headers: Record<string, string> },
        ];
        expect(url).toBe(OUTBOUND_URL);
        expect(options.method).toBe('POST');
        expect(options.body).toBe(JSON.stringify(payload));
        expect(options.headers['X-Signature']).toBe(
          crypto
            .createHmac('sha256', SECRET)
            .update(`${options.headers['X-Timestamp']}.${options.body}`)
            .digest('hex')
        );
      } finally {
        await valid.stop();
        vi.unstubAllGlobals();
      }
    }
  );

  // --- Loop budget ---

  describe('hop budget across a webhook round trip', () => {
    // Point an outbound webhook at a service that answers back through the
    // inbound endpoint and you have a loop. Every lap used to arrive as a
    // brand-new message with a brand-new budget, so the hop counter reset each
    // time and the guard that exists to stop this never fired.

    beforeEach(async () => {
      await adapter.start(relay);
    });

    it('counts one more hop when the request echoes the budget back', async () => {
      const body = '{"event":"echo"}';
      const headers = {
        ...buildHeaders(body, SECRET),
        'x-relay-hop-count': '2',
        'x-relay-max-hops': '5',
      };

      await adapter.handleInbound(Buffer.from(body), headers);

      const [, , options] = vi.mocked(relay.publish).mock.calls[0]!;
      expect(options.budget).toEqual({ hopCount: 3, maxHops: 5 });
    });

    it('clamps a declared ceiling instead of trusting it', async () => {
      // `hopCount` can only ever shorten a chain, so a wrong value there is
      // self-limiting. `maxHops` is the opposite: a caller declaring 1000 would
      // hand itself a thousand laps. A request may lower its own ceiling, never
      // raise it.
      const body = '{"event":"greedy"}';
      const headers = {
        ...buildHeaders(body, SECRET),
        'x-relay-hop-count': '0',
        'x-relay-max-hops': '1000',
      };

      await adapter.handleInbound(Buffer.from(body), headers);

      const [, , options] = vi.mocked(relay.publish).mock.calls[0]!;
      expect(options.budget).toEqual({ hopCount: 1, maxHops: 5 });
    });

    it('carries a DECREMENTED call budget and the original deadline back in (DOR-791)', async () => {
      // The lap that just happened cost a turn, so the republish carries one
      // less — a webhook pointed back at DorkOS now runs down a real budget
      // instead of getting a fresh ten every time round.
      const deadline = Date.now() + 120_000;
      const body = '{"event":"echo"}';
      const headers = {
        ...buildHeaders(body, SECRET),
        'x-relay-hop-count': '1',
        'x-relay-max-hops': '5',
        'x-relay-call-budget': '4',
        'x-relay-expires-at': String(deadline),
      };

      await adapter.handleInbound(Buffer.from(body), headers);

      const [, , options] = vi.mocked(relay.publish).mock.calls[0]!;
      expect(options.budget).toEqual({
        hopCount: 2,
        maxHops: 5,
        callBudgetRemaining: 3,
        ttl: deadline,
      });
    });

    it('floors a spent call budget at zero, which is what the publish gate refuses', async () => {
      const body = '{"event":"spent"}';
      const headers = {
        ...buildHeaders(body, SECRET),
        'x-relay-hop-count': '1',
        'x-relay-call-budget': '0',
      };

      await adapter.handleInbound(Buffer.from(body), headers);

      const [, , options] = vi.mocked(relay.publish).mock.calls[0]!;
      expect((options.budget as { callBudgetRemaining: number }).callBudgetRemaining).toBe(0);
    });

    it('clamps a declared call budget and deadline instead of trusting them', async () => {
      // The mirror of the maxHops clamp: a caller cannot vote itself a bigger
      // allowance or a longer life by echoing bigger numbers.
      const body = '{"event":"greedy"}';
      const headers = {
        ...buildHeaders(body, SECRET),
        'x-relay-hop-count': '1',
        'x-relay-call-budget': '9999',
        'x-relay-expires-at': String(Date.now() + 999_999_999),
      };

      await adapter.handleInbound(Buffer.from(body), headers);

      const [, , options] = vi.mocked(relay.publish).mock.calls[0]!;
      const budget = options.budget as { callBudgetRemaining: number; ttl: number };
      expect(budget.callBudgetRemaining).toBe(9);
      expect(budget.ttl).toBeLessThanOrEqual(Date.now() + 3_600_000);
    });

    it('ignores an unreadable hop count rather than trusting it', async () => {
      const body = '{"event":"junk"}';
      const headers = { ...buildHeaders(body, SECRET), 'x-relay-hop-count': 'lots' };

      await adapter.handleInbound(Buffer.from(body), headers);

      const [, , options] = vi.mocked(relay.publish).mock.calls[0]!;
      expect(options.budget).toBeUndefined();
    });
  });

  // --- Outbound delivery ---

  describe('deliver()', () => {
    beforeEach(async () => {
      await adapter.start(relay);
    });

    it('sends HTTP POST with correct HMAC headers', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);

      const envelope = {
        id: 'env-01',
        subject: 'relay.webhook.test',
        from: 'relay.agent.backend',
        budget: {
          hopCount: 0,
          maxHops: 5,
          ancestorChain: [],
          ttl: Date.now() + 3600000,
          callBudgetRemaining: 10,
        },
        createdAt: new Date().toISOString(),
        payload: { message: 'hello from relay' },
      };

      await adapter.deliver('relay.webhook.test', envelope);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0] as [
        string,
        RequestInit & { headers: Record<string, string> },
      ];
      expect(url).toBe(OUTBOUND_URL);
      expect(options.method).toBe('POST');
      // Never followed: a redirect would carry the signed body and custom
      // headers to an address nobody approved (DOR-3271).
      expect(options.redirect).toBe('manual');
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(options.headers['X-Signature']).toBeTruthy();
      expect(options.headers['X-Timestamp']).toBeTruthy();
      expect(options.headers['X-Nonce']).toBeTruthy();

      vi.unstubAllGlobals();
    });

    it('signs with the correct HMAC format (timestamp.body)', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);

      const payload = { text: 'signed message' };
      const envelope = {
        id: 'env-02',
        subject: 'relay.webhook.test',
        from: 'relay.agent.sender',
        budget: {
          hopCount: 0,
          maxHops: 5,
          ancestorChain: [],
          ttl: Date.now() + 3600000,
          callBudgetRemaining: 10,
        },
        createdAt: new Date().toISOString(),
        payload,
      };

      await adapter.deliver('relay.webhook.test', envelope);

      const [, options] = fetchMock.mock.calls[0] as [
        string,
        RequestInit & { headers: Record<string, string> },
      ];
      const { 'X-Signature': sig, 'X-Timestamp': ts } = options.headers;
      const body = JSON.stringify(payload);
      const message = `${ts}.${body}`;
      const expectedSig = crypto.createHmac('sha256', SECRET).update(message).digest('hex');

      expect(sig).toBe(expectedSig);

      vi.unstubAllGlobals();
    });

    it('returns failure result and sets error status on non-2xx HTTP response', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
      vi.stubGlobal('fetch', fetchMock);

      const envelope = {
        id: 'e1',
        subject: 'relay.webhook.test',
        from: 'a',
        budget: {
          hopCount: 0,
          maxHops: 5,
          ancestorChain: [],
          ttl: Date.now() + 3600000,
          callBudgetRemaining: 10,
        },
        createdAt: new Date().toISOString(),
        payload: {},
      };

      const result = await adapter.deliver('relay.webhook.test', envelope);
      expect(result.success).toBe(false);
      expect(result.error).toContain('503');

      const status = adapter.getStatus();
      expect(status.errorCount).toBe(1);
      expect(status.lastError).toContain('503');

      vi.unstubAllGlobals();
    });
  });
});

// --- Adapter Compliance Suite ---
// Stub global fetch so outbound deliver() does not make real HTTP requests.

describe('WebhookAdapter compliance', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  runAdapterComplianceSuite({
    name: 'WebhookAdapter',
    createAdapter: () =>
      new WebhookAdapter('test-webhook', {
        inbound: { subject: 'relay.webhook.test', secret: SECRET },
        outbound: { url: 'https://example.com/hook', secret: SECRET },
      }),
    deliverSubject: 'relay.webhook.test',
    capabilities: {
      // Webhook suppresses replayed inbound requests via its nonce map: the same
      // signed request (identical X-Nonce) delivered twice publishes only once.
      duplicateInbound: {
        deliverTwice: async (relay) => {
          const dupAdapter = new WebhookAdapter('dup-webhook', {
            inbound: { subject: 'relay.webhook.dup', secret: SECRET },
            outbound: { url: 'https://example.com/hook', secret: SECRET },
          });
          await dupAdapter.start(relay);
          const body = JSON.stringify({ hello: 'world' });
          const headers = buildHeaders(body, SECRET);
          const raw = Buffer.from(body);
          await dupAdapter.handleInbound(raw, headers);
          await dupAdapter.handleInbound(raw, headers);
          await dupAdapter.stop();
          return vi.mocked(relay.publish).mock.calls.length;
        },
      },
    },
  });
});
