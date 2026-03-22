/**
 * Adapter compliance test suite.
 *
 * Run this suite against any RelayAdapter implementation to verify correctness.
 *
 * @module relay/testing/compliance-suite
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RelayAdapter } from '../types.js';
import type { ThreadIdCodec } from '../lib/thread-id.js';
import { createMockRelayPublisher } from './mock-relay-publisher.js';
import { createMockRelayEnvelope } from './mock-relay-envelope.js';

/** Options for the adapter compliance test suite. */
export interface ComplianceSuiteOptions {
  /** Human-readable name for the test suite (e.g., 'TelegramAdapter'). */
  name: string;
  /** Factory function that creates a fresh adapter instance for each test. */
  createAdapter: () => RelayAdapter;
  /** Subject to use for delivery tests. Must match the adapter's subjectPrefix. */
  deliverSubject: string;
  /** Optional ThreadIdCodec for round-trip compliance testing. */
  codec?: ThreadIdCodec;
  /** Sample platform ID for codec round-trip tests (e.g., '12345'). */
  samplePlatformId?: string;
}

/**
 * Run the adapter compliance test suite.
 *
 * Validates that an adapter correctly implements the RelayAdapter contract:
 * 1. Shape compliance (all required properties and methods exist)
 * 2. Status lifecycle (initial state, connected after start, disconnected after stop)
 * 3. Start/stop idempotency (calling start twice or stop twice does not throw)
 * 4. getStatus() returns a valid AdapterStatus shape
 * 5. deliver() returns a DeliveryResult
 * 6. testConnection() shape (if present)
 *
 * Modeled on the abstract-blob-store compliance pattern.
 *
 * @example
 * ```typescript
 * import { runAdapterComplianceSuite } from '@dorkos/relay/testing';
 *
 * runAdapterComplianceSuite({
 *   name: 'MyAdapter',
 *   createAdapter: () => new MyAdapter('test', { ... }),
 *   deliverSubject: 'relay.custom.mine.test',
 * });
 * ```
 */
export function runAdapterComplianceSuite(options: ComplianceSuiteOptions): void {
  const { name, createAdapter, deliverSubject, codec, samplePlatformId } = options;

  describe(`${name} — Adapter Compliance Suite`, () => {
    let adapter: RelayAdapter;
    let relay: ReturnType<typeof createMockRelayPublisher>;

    beforeEach(() => {
      adapter = createAdapter();
      relay = createMockRelayPublisher();
    });

    afterEach(async () => {
      try {
        await adapter.stop();
      } catch {
        // Swallow — adapter may already be stopped
      }
    });

    // --- Shape compliance ---

    it('has a string id', () => {
      expect(typeof adapter.id).toBe('string');
      expect(adapter.id.length).toBeGreaterThan(0);
    });

    it('has a subjectPrefix (string or string[])', () => {
      const prefix = adapter.subjectPrefix;
      const isValid =
        typeof prefix === 'string' ||
        (Array.isArray(prefix) && prefix.every((p) => typeof p === 'string'));
      expect(isValid).toBe(true);
    });

    it('has a string displayName', () => {
      expect(typeof adapter.displayName).toBe('string');
      expect(adapter.displayName.length).toBeGreaterThan(0);
    });

    it('has start, stop, deliver, and getStatus methods', () => {
      expect(typeof adapter.start).toBe('function');
      expect(typeof adapter.stop).toBe('function');
      expect(typeof adapter.deliver).toBe('function');
      expect(typeof adapter.getStatus).toBe('function');
    });

    // --- Status lifecycle ---

    it('initial status state is "disconnected"', () => {
      const status = adapter.getStatus();
      expect(status.state).toBe('disconnected');
    });

    it('getStatus() returns a valid AdapterStatus shape', () => {
      const status = adapter.getStatus();
      expect(status).toHaveProperty('state');
      expect(status).toHaveProperty('messageCount');
      expect(status.messageCount).toHaveProperty('inbound');
      expect(status.messageCount).toHaveProperty('outbound');
      expect(typeof status.messageCount.inbound).toBe('number');
      expect(typeof status.messageCount.outbound).toBe('number');
      expect(status).toHaveProperty('errorCount');
      expect(typeof status.errorCount).toBe('number');
    });

    it('getStatus() returns a copy (not a reference)', () => {
      const status1 = adapter.getStatus();
      const status2 = adapter.getStatus();
      expect(status1).not.toBe(status2);
      expect(status1).toEqual(status2);
    });

    // --- Start/stop idempotency ---

    it('start() is idempotent (calling twice does not throw)', async () => {
      await adapter.start(relay);
      await expect(adapter.start(relay)).resolves.not.toThrow();
    });

    it('stop() is idempotent (calling twice does not throw)', async () => {
      await adapter.start(relay);
      await adapter.stop();
      await expect(adapter.stop()).resolves.not.toThrow();
    });

    it('stop() without start() does not throw', async () => {
      await expect(adapter.stop()).resolves.not.toThrow();
    });

    // --- deliver() ---

    it('deliver() returns a result (not undefined)', async () => {
      await adapter.start(relay);
      const envelope = createMockRelayEnvelope({ subject: deliverSubject });
      const result = await adapter.deliver(deliverSubject, envelope);
      // DeliveryResult must be defined — undefined would indicate a missing return
      expect(result).toBeDefined();
    });

    // --- testConnection() ---

    it('testConnection() returns { ok: boolean } if present', async () => {
      if (!adapter.testConnection) return; // optional method
      const result = await adapter.testConnection();
      expect(result).toHaveProperty('ok');
      expect(typeof result.ok).toBe('boolean');
      if (!result.ok) {
        expect(result).toHaveProperty('error');
        expect(typeof result.error).toBe('string');
      }
    });

    // --- StreamEvent handling ---

    it('deliver() does not send raw JSON for text_delta StreamEvents', async () => {
      await adapter.start(relay);
      const envelope = createMockRelayEnvelope({
        subject: deliverSubject,
        from: 'relay.agents.compliance-test',
        payload: { type: 'text_delta', data: { text: 'chunk' } },
      });
      const result = await adapter.deliver(deliverSubject, envelope);
      // Must succeed (buffered or delivered) — must not fail with serialization errors
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    it('deliver() succeeds for done StreamEvents', async () => {
      await adapter.start(relay);
      const envelope = createMockRelayEnvelope({
        subject: deliverSubject,
        from: 'relay.agents.compliance-test',
        payload: { type: 'done', data: {} },
      });
      const result = await adapter.deliver(deliverSubject, envelope);
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    it('deliver() silently drops unrecognized StreamEvent types', async () => {
      await adapter.start(relay);
      const envelope = createMockRelayEnvelope({
        subject: deliverSubject,
        from: 'relay.agents.compliance-test',
        payload: { type: 'session_status', data: { status: 'active' } },
      });
      const result = await adapter.deliver(deliverSubject, envelope);
      // Must succeed without error — unrecognized types are silently dropped
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    // --- deliverStream() shape (optional) ---

    it('deliverStream() is a function if present', () => {
      if (!('deliverStream' in adapter)) return;
      expect(typeof (adapter as { deliverStream: unknown }).deliverStream).toBe('function');
    });

    // --- ThreadIdCodec compliance (optional) ---

    if (codec && samplePlatformId) {
      describe('ThreadIdCodec round-trip', () => {
        it('round-trips DM encode/decode', () => {
          const subject = codec.encode(samplePlatformId, 'dm');
          const decoded = codec.decode(subject);
          expect(decoded).toEqual({ platformId: samplePlatformId, channelType: 'dm' });
        });

        it('round-trips group encode/decode', () => {
          const subject = codec.encode(samplePlatformId, 'group');
          const decoded = codec.decode(subject);
          expect(decoded).toEqual({ platformId: samplePlatformId, channelType: 'group' });
        });

        it('decode returns null for non-matching subject', () => {
          expect(codec.decode('relay.unrelated.prefix.123')).toBeNull();
        });

        it('encoded DM subject starts with codec prefix', () => {
          const subject = codec.encode(samplePlatformId, 'dm');
          expect(subject.startsWith(codec.prefix)).toBe(true);
        });

        it('encoded group subject starts with codec prefix', () => {
          const subject = codec.encode(samplePlatformId, 'group');
          expect(subject.startsWith(codec.prefix)).toBe(true);
        });
      });
    }
  });
}
