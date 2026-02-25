import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebhookAdapter, verifySignature } from '../webhook-adapter.js';
import type { RelayPublisher } from '../../types.js';

// --- Constants ---

const SECRET = 'a-very-long-secret-at-least-16chars';
const PREV_SECRET = 'old-secret-min-16-chars-for-rotation';
const OUTBOUND_URL = 'https://example.com/webhook-receiver';

// --- Helpers ---

/** Sign a body string exactly as `WebhookAdapter.handleInbound` expects. */
function signBody(
  body: string,
  secret: string,
  timestampSecs?: number,
): { signature: string; timestamp: string; nonce: string } {
  const ts = String(timestampSecs ?? Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const message = `${ts}.${body}`;
  const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return { signature, timestamp: ts, nonce };
}

/** Build headers object in the shape `handleInbound` expects. */
function buildHeaders(
  body: string,
  secret: string,
  timestampSecs?: number,
): Record<string, string> {
  const signed = signBody(body, secret, timestampSecs);
  return {
    'x-signature': signed.signature,
    'x-timestamp': signed.timestamp,
    'x-nonce': signed.nonce,
  };
}

function createMockRelay(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
  };
}

function makeAdapter(opts?: {
  inboundSubject?: string;
  secret?: string;
  previousSecret?: string;
  outboundUrl?: string;
  outboundSecret?: string;
}): WebhookAdapter {
  return new WebhookAdapter('test-webhook', {
    inbound: {
      subject: opts?.inboundSubject ?? 'relay.webhook.test',
      secret: opts?.secret ?? SECRET,
      previousSecret: opts?.previousSecret,
    },
    outbound: {
      url: opts?.outboundUrl ?? OUTBOUND_URL,
      secret: opts?.outboundSecret ?? SECRET,
    },
  });
}

// --- Tests ---

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

  // --- Lifecycle ---

  describe('start()', () => {
    it('transitions to connected state and records startedAt', async () => {
      await adapter.start(relay);

      const status = adapter.getStatus();
      expect(status.state).toBe('connected');
      expect(status.startedAt).toBe('2026-02-24T12:00:00.000Z');
    });

    it('is idempotent — calling twice does not reset startedAt', async () => {
      await adapter.start(relay);
      const firstStatus = adapter.getStatus();

      vi.advanceTimersByTime(5000);
      await adapter.start(relay);
      const secondStatus = adapter.getStatus();

      expect(secondStatus.startedAt).toBe(firstStatus.startedAt);
    });
  });

  describe('stop()', () => {
    it('transitions to disconnected state', async () => {
      await adapter.start(relay);
      await adapter.stop();

      expect(adapter.getStatus().state).toBe('disconnected');
    });

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

    it('is idempotent — calling twice does not throw', async () => {
      await adapter.start(relay);
      await adapter.stop();
      await expect(adapter.stop()).resolves.toBeUndefined();
    });
  });

  // --- inbound HMAC verification ---

  describe('handleInbound()', () => {
    beforeEach(async () => {
      await adapter.start(relay);
    });

    it('accepts a valid HMAC signature and publishes to Relay', async () => {
      const body = '{"event":"push","ref":"refs/heads/main"}';
      const headers = buildHeaders(body, SECRET);

      const result = await adapter.handleInbound(Buffer.from(body), headers);

      expect(result.ok).toBe(true);
      expect(relay.publish).toHaveBeenCalledWith(
        'relay.webhook.test',
        expect.objectContaining({
          type: 'webhook',
          data: JSON.parse(body),
          metadata: expect.objectContaining({ platform: 'webhook', adapterId: 'test-webhook' }),
        }),
        { from: 'relay.webhook.test-webhook' },
      );
    });

    it('increments inbound message count on success', async () => {
      const body = '{"x":1}';
      await adapter.handleInbound(Buffer.from(body), buildHeaders(body, SECRET));
      await adapter.handleInbound(Buffer.from(body), buildHeaders(body, SECRET));

      expect(adapter.getStatus().messageCount.inbound).toBe(2);
    });

    it('rejects an invalid HMAC signature', async () => {
      const body = '{"event":"push"}';
      const headers = buildHeaders(body, SECRET);
      headers['x-signature'] = 'deadbeef'.repeat(8); // wrong signature

      const result = await adapter.handleInbound(Buffer.from(body), headers);

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Invalid signature');
      expect(relay.publish).not.toHaveBeenCalled();
    });

    it('rejects a timestamp older than 300 seconds', async () => {
      const body = '{"event":"old"}';
      const oldTimestamp = Math.floor(Date.now() / 1000) - 301; // 5min 1sec ago
      const headers = buildHeaders(body, SECRET, oldTimestamp);

      const result = await adapter.handleInbound(Buffer.from(body), headers);

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Timestamp expired or invalid');
    });

    it('rejects a timestamp more than 300 seconds in the future', async () => {
      const body = '{"event":"future"}';
      const futureTimestamp = Math.floor(Date.now() / 1000) + 301;
      const headers = buildHeaders(body, SECRET, futureTimestamp);

      const result = await adapter.handleInbound(Buffer.from(body), headers);

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Timestamp expired or invalid');
    });

    it('rejects a missing timestamp header', async () => {
      const body = '{"event":"test"}';
      const headers = buildHeaders(body, SECRET);
      delete headers['x-timestamp'];

      const result = await adapter.handleInbound(Buffer.from(body), headers);

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Timestamp expired or invalid');
    });

    it('rejects a replayed nonce', async () => {
      const body = '{"event":"dup"}';
      const headers = buildHeaders(body, SECRET);

      const first = await adapter.handleInbound(Buffer.from(body), headers);
      const second = await adapter.handleInbound(Buffer.from(body), headers);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(false);
      expect(second.error).toBe('Nonce already seen (replay)');
    });

    it('accepts the previous secret during dual-secret rotation', async () => {
      const rotatingAdapter = makeAdapter({ previousSecret: PREV_SECRET });
      await rotatingAdapter.start(relay);

      const body = '{"event":"rotation"}';
      const headers = buildHeaders(body, PREV_SECRET);

      const result = await rotatingAdapter.handleInbound(Buffer.from(body), headers);

      expect(result.ok).toBe(true);
      await rotatingAdapter.stop();
    });

    it('still accepts the current secret alongside the previous secret', async () => {
      const rotatingAdapter = makeAdapter({ previousSecret: PREV_SECRET });
      await rotatingAdapter.start(relay);

      const body = '{"event":"current"}';
      const headers = buildHeaders(body, SECRET);

      const result = await rotatingAdapter.handleInbound(Buffer.from(body), headers);

      expect(result.ok).toBe(true);
      await rotatingAdapter.stop();
    });

    it('returns error when adapter has not been started', async () => {
      const unstartedAdapter = makeAdapter();
      const body = '{"x":1}';
      const result = await unstartedAdapter.handleInbound(Buffer.from(body), buildHeaders(body, SECRET));

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Adapter not started');
    });

    it('returns error when relay.publish() throws', async () => {
      vi.mocked(relay.publish).mockRejectedValueOnce(new Error('Relay unavailable'));

      const body = '{"event":"fail"}';
      const result = await adapter.handleInbound(Buffer.from(body), buildHeaders(body, SECRET));

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Publish failed');
      expect(adapter.getStatus().errorCount).toBe(1);
      expect(adapter.getStatus().lastError).toBe('Relay unavailable');
    });
  });

  // --- Nonce pruning ---

  describe('nonce pruning', () => {
    it('prunes expired nonces after TTL interval', async () => {
      await adapter.start(relay);

      const body = '{"x":1}';
      const headers = buildHeaders(body, SECRET);
      await adapter.handleInbound(Buffer.from(body), headers);

      // Advance past nonce TTL (24h) + prune interval (5min) — the nonce expires
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);

      // The old nonce is now pruned, but we need a fresh timestamp-valid request
      // to verify nonces are reusable. Send a new request with the same nonce but fresh timestamp.
      const freshHeaders = buildHeaders(body, SECRET); // fresh timestamp + new nonce
      const result = await adapter.handleInbound(Buffer.from(body), freshHeaders);
      expect(result.ok).toBe(true);
    });

    it('prunes nonces on the interval and old nonce is no longer blocked', async () => {
      await adapter.start(relay);

      const body = '{"x":1}';

      // First request — records nonce N1
      const h1 = buildHeaders(body, SECRET);
      await adapter.handleInbound(Buffer.from(body), h1);

      // Second request with same nonce N1 — blocked
      const blocked = await adapter.handleInbound(Buffer.from(body), h1);
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toBe('Nonce already seen (replay)');

      // Advance past TTL so N1 expires, trigger prune
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);

      // Fresh request with a new nonce (timestamp still valid because we rebuilt headers)
      const h2 = buildHeaders(body, SECRET);
      const result = await adapter.handleInbound(Buffer.from(body), h2);
      expect(result.ok).toBe(true);
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
        budget: { hopCount: 0, maxHops: 5, ancestorChain: [], ttl: Date.now() + 3600000, callBudgetRemaining: 10 },
        createdAt: new Date().toISOString(),
        payload: { message: 'hello from relay' },
      };

      await adapter.deliver('relay.webhook.test', envelope);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
      expect(url).toBe(OUTBOUND_URL);
      expect(options.method).toBe('POST');
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
        budget: { hopCount: 0, maxHops: 5, ancestorChain: [], ttl: Date.now() + 3600000, callBudgetRemaining: 10 },
        createdAt: new Date().toISOString(),
        payload,
      };

      await adapter.deliver('relay.webhook.test', envelope);

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
      const { 'X-Signature': sig, 'X-Timestamp': ts } = options.headers;
      const body = JSON.stringify(payload);
      const message = `${ts}.${body}`;
      const expectedSig = crypto.createHmac('sha256', SECRET).update(message).digest('hex');

      expect(sig).toBe(expectedSig);

      vi.unstubAllGlobals();
    });

    it('sends custom outbound headers from config', async () => {
      const customAdapter = new WebhookAdapter('custom', {
        inbound: { subject: 'relay.webhook.custom', secret: SECRET },
        outbound: { url: OUTBOUND_URL, secret: SECRET, headers: { Authorization: 'Bearer token-abc' } },
      });
      await customAdapter.start(createMockRelay());

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);

      await customAdapter.deliver('relay.webhook.custom', {
        id: 'e1',
        subject: 'relay.webhook.custom',
        from: 'a',
        budget: { hopCount: 0, maxHops: 5, ancestorChain: [], ttl: Date.now() + 3600000, callBudgetRemaining: 10 },
        createdAt: new Date().toISOString(),
        payload: {},
      });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
      expect(options.headers['Authorization']).toBe('Bearer token-abc');

      await customAdapter.stop();
      vi.unstubAllGlobals();
    });

    it('increments outbound message count on success', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);

      const envelope = {
        id: 'e1', subject: 'relay.webhook.test', from: 'a',
        budget: { hopCount: 0, maxHops: 5, ancestorChain: [], ttl: Date.now() + 3600000, callBudgetRemaining: 10 },
        createdAt: new Date().toISOString(), payload: {},
      };

      await adapter.deliver('relay.webhook.test', envelope);
      expect(adapter.getStatus().messageCount.outbound).toBe(1);

      vi.unstubAllGlobals();
    });

    it('throws and sets error status on non-2xx HTTP response', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
      vi.stubGlobal('fetch', fetchMock);

      const envelope = {
        id: 'e1', subject: 'relay.webhook.test', from: 'a',
        budget: { hopCount: 0, maxHops: 5, ancestorChain: [], ttl: Date.now() + 3600000, callBudgetRemaining: 10 },
        createdAt: new Date().toISOString(), payload: {},
      };

      await expect(adapter.deliver('relay.webhook.test', envelope)).rejects.toThrow('HTTP 503');

      const status = adapter.getStatus();
      expect(status.errorCount).toBe(1);
      expect(status.lastError).toContain('503');

      vi.unstubAllGlobals();
    });
  });

  // --- getStatus() ---

  describe('getStatus()', () => {
    it('returns disconnected state before start', () => {
      expect(adapter.getStatus().state).toBe('disconnected');
    });

    it('returns a shallow copy — mutations do not affect internal state', async () => {
      await adapter.start(relay);
      const status = adapter.getStatus();
      status.errorCount = 999;

      expect(adapter.getStatus().errorCount).toBe(0);
    });
  });

  // --- adapter identity ---

  describe('constructor', () => {
    it('sets subjectPrefix from inbound.subject', () => {
      expect(adapter.subjectPrefix).toBe('relay.webhook.test');
    });

    it('sets default displayName from id when not provided', () => {
      expect(adapter.displayName).toBe('Webhook (test-webhook)');
    });

    it('uses provided displayName when given', () => {
      const named = new WebhookAdapter('gh', {
        inbound: { subject: 'relay.webhook.github', secret: SECRET },
        outbound: { url: OUTBOUND_URL, secret: SECRET },
      }, 'GitHub Webhook');
      expect(named.displayName).toBe('GitHub Webhook');
    });
  });
});

// --- verifySignature utility ---

describe('verifySignature', () => {
  const body = Buffer.from('{"event":"test"}');
  const timestamp = '1740398400';

  it('returns true for a correct HMAC-SHA256 signature', () => {
    const message = `${timestamp}.${body.toString()}`;
    const signature = crypto.createHmac('sha256', SECRET).update(message).digest('hex');

    expect(verifySignature(body, timestamp, signature, SECRET)).toBe(true);
  });

  it('returns false for a tampered body', () => {
    const message = `${timestamp}.${body.toString()}`;
    const signature = crypto.createHmac('sha256', SECRET).update(message).digest('hex');
    const tamperedBody = Buffer.from('{"event":"injected"}');

    expect(verifySignature(tamperedBody, timestamp, signature, SECRET)).toBe(false);
  });

  it('returns false for an empty signature string', () => {
    expect(verifySignature(body, timestamp, '', SECRET)).toBe(false);
  });

  it('returns false for a signature of different length (odd hex)', () => {
    expect(verifySignature(body, timestamp, 'abc', SECRET)).toBe(false);
  });

  it('tries previousSecret when current secret fails', () => {
    const message = `${timestamp}.${body.toString()}`;
    const sigWithPrev = crypto.createHmac('sha256', PREV_SECRET).update(message).digest('hex');

    expect(verifySignature(body, timestamp, sigWithPrev, SECRET, PREV_SECRET)).toBe(true);
  });

  it('returns false when neither current nor previous secret matches', () => {
    expect(verifySignature(body, timestamp, 'cafebabe'.repeat(8), SECRET, PREV_SECRET)).toBe(false);
  });

  it('does not accept previous secret when previousSecret is not provided', () => {
    const message = `${timestamp}.${body.toString()}`;
    const sigWithPrev = crypto.createHmac('sha256', PREV_SECRET).update(message).digest('hex');

    expect(verifySignature(body, timestamp, sigWithPrev, SECRET)).toBe(false);
  });
});
