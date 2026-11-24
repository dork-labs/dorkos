import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockRelay } from '../../../__tests__/fixtures.js';
import { WebhookAdapter, verifySignature } from '../webhook-adapter.js';
import type { RelayPublisher } from '../../../types.js';
import { SECRET, PREV_SECRET, buildHeaders, makeAdapter } from './webhook-adapter.fixtures.js';

describe('WebhookAdapter inbound', () => {
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
        { from: 'relay.webhook.test-webhook' }
      );
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

    it('rejects a missing nonce header with a 400 status', async () => {
      const body = '{"event":"test"}';
      const headers = buildHeaders(body, SECRET);
      delete headers['x-nonce'];

      const result = await adapter.handleInbound(Buffer.from(body), headers);

      expect(result.ok).toBe(false);
      expect(result.status).toBe(400);
      expect(result.error).toContain('Nonce');
    });

    it('does not brick subsequent nonce-less requests after the first', async () => {
      const body = '{"event":"test"}';
      const h1 = buildHeaders(body, SECRET);
      delete h1['x-nonce'];
      const h2 = buildHeaders(body, SECRET);
      delete h2['x-nonce'];

      // Both requests are rejected identically — an absent nonce never registers
      // the empty-string key that would turn later requests into false "replays".
      const first = await adapter.handleInbound(Buffer.from(body), h1);
      const second = await adapter.handleInbound(Buffer.from(body), h2);

      expect(first.error).toBe('Missing X-Nonce header');
      expect(second.error).toBe('Missing X-Nonce header');
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
      const result = await unstartedAdapter.handleInbound(
        Buffer.from(body),
        buildHeaders(body, SECRET)
      );

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Adapter not started');
      // Not a signature failure: the caller should send it again later.
      expect(result.status).toBe(503);
    });

    // An unsigned caller must not learn the connection exists but isn't running.
    it('answers an unsigned request to an unstarted adapter as any bad signature', async () => {
      const unstartedAdapter = makeAdapter();
      const body = '{"x":1}';
      const result = await unstartedAdapter.handleInbound(
        Buffer.from(body),
        buildHeaders(body, 'not-the-secret-at-all')
      );

      expect(result.ok).toBe(false);
      expect(result.status).toBeUndefined();
    });

    it('returns error when relay.publish() throws', async () => {
      vi.mocked(relay.publish).mockRejectedValueOnce(new Error('Relay unavailable'));

      const body = '{"event":"fail"}';
      const result = await adapter.handleInbound(Buffer.from(body), buildHeaders(body, SECRET));

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Publish failed');
      // A delivery failure after the signature passed, never the signature's 401.
      expect(result.status).toBe(500);
      expect(adapter.getStatus().errorCount).toBe(1);
      expect(adapter.getStatus().lastError).toBe('Relay unavailable');
    });
  });

  // --- Nonce pruning ---

  describe('nonce pruning', () => {
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
