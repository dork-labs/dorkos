/**
 * Adapter compliance test suite.
 *
 * Run this suite against any RelayAdapter implementation to verify correctness.
 *
 * The suite is split into two tiers:
 *
 * 1. **Contract checks** — shape, status lifecycle, start/stop idempotency, and
 *    StreamEvent handling. The lifecycle and delivery checks require a headless
 *    `start()`; adapters that can only start against live credentials or a
 *    network (telegram, slack) declare `capabilities.startable: false` and the
 *    suite skips them (running them would open a real connection, not verify a
 *    contract).
 *
 * 2. **Capability-driven checks** — echo prevention, message splitting, adversarial
 *    approval-input safety, and duplicate-inbound suppression. Each is **opt-in**:
 *    an adapter declares the capability and provides the concrete hook the check
 *    exercises against real adapter code. An adapter that cannot run a check
 *    headlessly simply omits the capability — there is no fake-green fallback.
 *
 * Every high-severity adapter bug the 2026-07 deep review found (echo loops,
 * split-after-format producing unbalanced markup, approval cards hard-failing on
 * unescaped tool input, duplicate inbound dispatch, start/stop interleaving) maps
 * to a check here. See `contributing/relay-adapters.md` for the capability model.
 *
 * @module relay/testing/compliance-suite
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RelayAdapter, RelayPublisher } from '../types.js';
import type { ThreadIdCodec } from '../lib/thread-id.js';
import { createMockRelayPublisher } from './mock-relay-publisher.js';
import { createMockRelayEnvelope } from './mock-relay-envelope.js';

/**
 * Opt-in capability declarations that unlock the runnable, bug-class-specific
 * sections of the compliance suite.
 *
 * Each field an adapter provides pins a concrete failure mode against the
 * adapter's real code. Omit a field when the adapter cannot exercise that check
 * headlessly — the suite skips it rather than assert a hollow pass.
 */
export interface AdapterCapabilities {
  /**
   * Whether `start()`/`stop()` complete headlessly, without live credentials or a
   * network connection. Defaults to `true`.
   *
   * Network-backed adapters (telegram, slack) set this to `false`: their `start()`
   * opens a real bot connection, so the lifecycle and delivery checks are skipped
   * and only the no-start capability checks below run.
   */
  startable?: boolean;

  /**
   * Whether `deliver()` renders relay StreamEvents to a channel (text_delta / done /
   * unrecognized-type handling). Defaults to `true`. Runtime-fixture adapters that
   * consume a different payload shape (e.g. test-mode) set this to `false`.
   */
  rendersStreamEvents?: boolean;

  /**
   * Echo prevention: `deliver()` must drop a message whose `from` is the adapter's
   * own platform identity, without attempting a platform send. Without this guard
   * an inbound message the adapter itself published loops back through delivery.
   */
  echoPrevention?: {
    /**
     * A `from` value the adapter treats as self-originated (matches its subject
     * prefix). Delivering this must short-circuit to success with no platform call.
     */
    selfFrom: string;
    /**
     * A `from` value from an external party — must NOT be treated as self, proving
     * the guard is selective rather than dropping everything.
     */
    externalFrom: string;
  };

  /**
   * Platform message splitting: an over-limit payload must split into chunks that
   * each fit the platform limit, stay well-formed (e.g. balanced HTML), and lose no
   * content. Pins the split-after-format class of bugs.
   */
  messageSplitting?: {
    /** Platform hard limit in characters that every emitted chunk must respect. */
    limit: number;
    /** The adapter's real split function under test. */
    split: (text: string) => string[];
    /** Predicate: a single emitted chunk is well-formed for the platform. */
    isValidChunk: (chunk: string) => boolean;
    /** Plain-text projection of a chunk for the no-content-loss check. Defaults to identity. */
    toPlainText?: (chunk: string) => string;
    /**
     * Optional markup-rich, over-limit sample used for the well-formedness check.
     * Provide it to force the real markdown→markup conversion (the split-after-format
     * regression); defaults to generated plain text.
     */
    sampleMarkup?: string;
  };

  /**
   * Adversarial approval-input safety: hostile tool input (backticks, angle
   * brackets, unbalanced markdown) rendered into the adapter's real card markup
   * must stay well-formed, so the approval card is never rejected by the platform
   * and the tool call never hangs waiting for a decision.
   */
  approvalInputSafety?: {
    /** Render tool-controlled input through the adapter's real escaping/formatting. */
    render: (toolName: string, input: string) => string;
    /** Predicate: the rendered markup is well-formed for the platform. */
    isValid: (rendered: string) => boolean;
  };

  /**
   * Duplicate-inbound suppression: the same platform event delivered twice must
   * publish to the relay exactly once.
   */
  duplicateInbound?: {
    /**
     * Drive the same inbound platform event through the adapter twice and resolve
     * to the number of relay publishes it produced. A compliant adapter suppresses
     * the duplicate, yielding exactly 1. The provided relay is a mock publisher.
     */
    deliverTwice: (relay: RelayPublisher) => Promise<number>;
  };
}

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
  /** Opt-in capability declarations that unlock the bug-class-specific sections. */
  capabilities?: AdapterCapabilities;
}

/**
 * Build a message long enough to force splitting, seeded with unique sentinel
 * tokens so a no-content-loss check can prove every token survived.
 *
 * @param limit - The platform character limit the message must comfortably exceed
 */
function buildLongMessage(limit: number): { text: string; markers: string[] } {
  const markers: string[] = [];
  const filler = ' the quick brown fox jumps over the lazy dog ';
  let text = '';
  let i = 0;
  // Overshoot to ~3x the limit so at least three chunks are produced.
  while (text.length < limit * 3) {
    const marker = `Sentinel${String(i).padStart(4, '0')}`;
    markers.push(marker);
    text += marker + filler;
    i += 1;
  }
  return { text, markers };
}

/**
 * Run the adapter compliance test suite.
 *
 * Validates that an adapter correctly implements the RelayAdapter contract:
 * 1. Shape compliance (all required properties and methods exist)
 * 2. Status lifecycle (initial state, connected after start, disconnected after stop)
 * 3. Start/stop idempotency + interleaving (calling start twice, or stop during an
 *    in-flight start, never leaks a connection or wedges the status)
 * 4. getStatus() returns a valid AdapterStatus shape
 * 5. deliver() returns a DeliveryResult and renders StreamEvents
 * 6. testConnection() shape (if present)
 * 7. Opt-in capability checks for the real adapter bug classes (echo, splitting,
 *    approval-input safety, duplicate inbound)
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
 *   capabilities: { echoPrevention: { selfFrom: 'relay.custom.mine.bot', externalFrom: 'agent:x' } },
 * });
 * ```
 */
export function runAdapterComplianceSuite(options: ComplianceSuiteOptions): void {
  const { name, createAdapter, deliverSubject, codec, samplePlatformId, capabilities } = options;
  const startable = capabilities?.startable ?? true;
  const rendersStreamEvents = capabilities?.rendersStreamEvents ?? true;

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

    it('stop() without start() does not throw', async () => {
      await expect(adapter.stop()).resolves.not.toThrow();
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

    // --- Lifecycle + delivery (requires a headless start) ---

    (startable ? describe : describe.skip)('lifecycle + delivery (startable)', () => {
      it('start() is idempotent (calling twice does not throw)', async () => {
        await adapter.start(relay);
        await expect(adapter.start(relay)).resolves.not.toThrow();
      });

      it('double start() results in a single connected adapter', async () => {
        await adapter.start(relay);
        await adapter.start(relay);
        expect(adapter.getStatus().state).toBe('connected');
      });

      it('stop() is idempotent (calling twice does not throw)', async () => {
        await adapter.start(relay);
        await adapter.stop();
        await expect(adapter.stop()).resolves.not.toThrow();
      });

      it('stop() interleaved with an in-flight start() ends disconnected and reusable', async () => {
        // The #119 interleaving: firing stop() before start() settles must not
        // leave the adapter wedged in 'starting'/'connected' with a leaked
        // connection. Do not await start() before stopping.
        const starting = adapter.start(relay);
        const stopping = adapter.stop();
        await Promise.allSettled([starting, stopping]);
        await adapter.stop();
        expect(adapter.getStatus().state).toBe('disconnected');

        // And the adapter is still usable afterward — a fresh cycle works cleanly.
        await adapter.start(relay);
        expect(adapter.getStatus().state).toBe('connected');
        await adapter.stop();
        expect(adapter.getStatus().state).toBe('disconnected');
      });

      it('deliver() returns a result (not undefined)', async () => {
        await adapter.start(relay);
        const envelope = createMockRelayEnvelope({ subject: deliverSubject });
        const result = await adapter.deliver(deliverSubject, envelope);
        // DeliveryResult must be defined — undefined would indicate a missing return
        expect(result).toBeDefined();
      });

      (rendersStreamEvents ? describe : describe.skip)('StreamEvent rendering', () => {
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
      });
    });

    // --- Capability: echo prevention (no start required) ---

    if (capabilities?.echoPrevention) {
      const echo = capabilities.echoPrevention;
      describe('echo prevention', () => {
        it('deliver() drops a self-originated message without touching the platform', async () => {
          // Unstarted on purpose: the echo guard must short-circuit to success
          // *before* any "not started" platform-send path. If the guard regressed,
          // this would fall through to a failed delivery and this assertion fails.
          const fresh = createAdapter();
          const envelope = createMockRelayEnvelope({
            subject: deliverSubject,
            from: echo.selfFrom,
          });
          const result = await fresh.deliver(deliverSubject, envelope);
          expect(result.success).toBe(true);
        });

        it('deliver() does not treat an external sender as self (guard is selective)', async () => {
          // An external message on an unstarted adapter attempts real delivery and
          // fails "not started" — proving the echo guard did not over-match and
          // swallow legitimate traffic.
          const fresh = createAdapter();
          const envelope = createMockRelayEnvelope({
            subject: deliverSubject,
            from: echo.externalFrom,
          });
          const result = await fresh.deliver(deliverSubject, envelope);
          expect(result.success).toBe(false);
        });
      });
    }

    // --- Capability: message splitting (pure split function) ---

    if (capabilities?.messageSplitting) {
      const split = capabilities.messageSplitting;
      const toPlainText = split.toPlainText ?? ((s: string) => s);
      describe('message splitting', () => {
        it('splits over-limit content into multiple chunks that each fit the limit', () => {
          const { text } = buildLongMessage(split.limit);
          const chunks = split.split(text);
          expect(chunks.length).toBeGreaterThan(1);
          for (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(split.limit);
          }
        });

        it('emits only well-formed chunks (balanced markup)', () => {
          const source = split.sampleMarkup ?? buildLongMessage(split.limit).text;
          const chunks = split.split(source);
          expect(chunks.length).toBeGreaterThan(0);
          for (const chunk of chunks) {
            expect(split.isValidChunk(chunk)).toBe(true);
            expect(chunk.length).toBeLessThanOrEqual(split.limit);
          }
        });

        it('preserves all content across the split (no dropped tokens)', () => {
          const { text, markers } = buildLongMessage(split.limit);
          const joined = split.split(text).map(toPlainText).join('');
          for (const marker of markers) {
            expect(joined).toContain(marker);
          }
        });

        it('returns a single chunk for within-limit content', () => {
          const chunks = split.split('a short message well under the limit');
          expect(chunks.length).toBe(1);
        });
      });
    }

    // --- Capability: adversarial approval-input safety (pure render) ---

    if (capabilities?.approvalInputSafety) {
      const approval = capabilities.approvalInputSafety;
      const adversarialInputs: Array<{ label: string; toolName: string; input: string }> = [
        { label: 'backticks', toolName: 'Bash', input: 'rm -rf `whoami`/*' },
        { label: 'angle brackets', toolName: 'Edit', input: '<script>alert(1)</script>' },
        { label: 'unbalanced markdown', toolName: 'Write', input: '**bold _italic `code' },
        { label: 'ampersands + entities', toolName: 'Bash', input: 'echo "a & b < c > d &amp;"' },
        { label: 'markup-lookalike tags', toolName: 'Edit', input: '</pre><b>injected</b><pre>' },
      ];
      describe('approval-input safety', () => {
        for (const { label, toolName, input } of adversarialInputs) {
          it(`renders valid markup for adversarial input (${label})`, () => {
            const rendered = approval.render(toolName, input);
            expect(typeof rendered).toBe('string');
            expect(approval.isValid(rendered)).toBe(true);
          });
        }
      });
    }

    // --- Capability: duplicate inbound suppression ---

    if (capabilities?.duplicateInbound) {
      const dup = capabilities.duplicateInbound;
      describe('duplicate inbound suppression', () => {
        it('publishes exactly once for a duplicated inbound event', async () => {
          const mockRelay = createMockRelayPublisher();
          const publishCount = await dup.deliverTwice(mockRelay);
          expect(publishCount).toBe(1);
        });
      });
    }

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
