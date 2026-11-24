import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { RelayCore } from '../../relay-core.js';
import type { Signal } from '@dorkos/shared/relay-schemas';
import type { AdapterRegistryLike, AdapterContext } from '../../types.js';
import { applyRelayCoreTimeouts, makeTmpDir } from './relay-core.fixtures.js';

applyRelayCoreTimeouts();

describe('reliability pipeline integration', () => {
  let rTmpDir: string;
  let rRelay: RelayCore;

  beforeEach(async () => {
    rTmpDir = await makeTmpDir('relay-reliability-test-');
    rRelay = new RelayCore({
      dataDir: rTmpDir,
      reliability: {
        rateLimit: { enabled: true, maxPerWindow: 5, windowSecs: 60 },
        circuitBreaker: { enabled: true, failureThreshold: 3, cooldownMs: 1000 },
        backpressure: { enabled: true, maxMailboxSize: 10, pressureWarningAt: 0.8 },
      },
    });
  });

  afterEach(async () => {
    await rRelay.close();
    await fs.rm(rTmpDir, { recursive: true, force: true });
  });

  it('rate limit check runs before fan-out (one check for multi-endpoint publish)', async () => {
    await rRelay.registerEndpoint('relay.agent.proj.a');
    await rRelay.registerEndpoint('relay.agent.proj.b');

    // Exhaust the rate limit (maxPerWindow: 5) by publishing to endpoint A
    for (let i = 0; i < 5; i++) {
      await rRelay.publish('relay.agent.proj.a', { i }, { from: 'relay.flood' });
    }

    // The 6th publish from the same sender should be rate-limited
    // even though it targets a different endpoint — rate limit is per-sender, before fan-out
    const result = await rRelay.publish(
      'relay.agent.proj.b',
      { data: 'blocked' },
      { from: 'relay.flood' }
    );

    // A real id, not an empty string: a rate-limited publish is traced like
    // every other non-delivery, and a trace needs something to key on (DOR-789).
    expect(result.messageId).not.toBe('');
    expect(result.deliveredTo).toBe(0);
    expect(result.rejected).toEqual([{ endpointHash: '*', reason: 'rate_limited' }]);
  });

  it('backpressure rejection skips Maildir delivery', async () => {
    // Use a relay with a very small mailbox to trigger backpressure
    await rRelay.close();
    rRelay = new RelayCore({
      dataDir: rTmpDir,
      reliability: {
        backpressure: { enabled: true, maxMailboxSize: 3, pressureWarningAt: 0.5 },
        rateLimit: { enabled: false },
      },
    });

    const info = await rRelay.registerEndpoint('relay.agent.bp');
    // No subscriber — messages stay in new/, building up backpressure

    // Fill the mailbox to capacity
    for (let i = 0; i < 3; i++) {
      await rRelay.publish('relay.agent.bp', { i }, { from: 'relay.sender.bp' });
    }

    // Next publish should be rejected by backpressure
    const result = await rRelay.publish(
      'relay.agent.bp',
      { data: 'backpressured' },
      { from: 'relay.sender.bp' }
    );

    expect(result.deliveredTo).toBe(0);
    expect(result.rejected).toBeDefined();
    expect(result.rejected!.some((r) => r.reason === 'backpressure')).toBe(true);

    // Verify no file was written for the rejected message by checking
    // the new/ directory still has exactly 3 files
    const newDir = path.join(info.maildirPath, 'new');
    const files = await fs.readdir(newDir);
    expect(files.length).toBe(3);

    // Reliability rejections are back-off, not failures: they skip the DLQ.
    expect(await rRelay.getDeadLetters({ endpointHash: info.hash })).toHaveLength(0);
  });

  it('circuit breaker rejection skips Maildir delivery', async () => {
    await rRelay.close();
    rRelay = new RelayCore({
      dataDir: rTmpDir,
      reliability: {
        circuitBreaker: { enabled: true, failureThreshold: 3, cooldownMs: 60_000 },
        rateLimit: { enabled: false },
      },
    });

    const info = await rRelay.registerEndpoint('relay.agent.cb');

    // Cause Maildir write errors by removing the tmp/ directory.
    // This triggers recordFailure WITHOUT a preceding recordSuccess,
    // so consecutiveFailures actually accumulates and trips the breaker.
    await fs.rm(path.join(info.maildirPath, 'tmp'), { recursive: true, force: true });

    // Cause enough failures to trip the circuit breaker (failureThreshold: 3)
    for (let i = 0; i < 3; i++) {
      await rRelay.publish('relay.agent.cb', { i }, { from: 'relay.sender.cb' });
    }

    // Restore the tmp/ directory so the Maildir write check isn't what blocks
    // the next publish — the circuit breaker should block it first
    await fs.mkdir(path.join(info.maildirPath, 'tmp'), { recursive: true });

    // The breaker should now be OPEN — next publish should be rejected
    const result = await rRelay.publish(
      'relay.agent.cb',
      { data: 'circuit-open' },
      { from: 'relay.sender.cb' }
    );

    expect(result.deliveredTo).toBe(0);
    expect(result.rejected).toBeDefined();
    expect(result.rejected!.some((r) => r.reason === 'circuit_open')).toBe(true);

    // Verify no new file was written for the circuit-breaker-rejected message
    const newDir = path.join(info.maildirPath, 'new');
    const newFiles = await fs.readdir(newDir);
    expect(newFiles.length).toBe(0);
  });

  it('backpressure signal emitted when pressure exceeds warning threshold', async () => {
    await rRelay.close();
    rRelay = new RelayCore({
      dataDir: rTmpDir,
      reliability: {
        backpressure: { enabled: true, maxMailboxSize: 5, pressureWarningAt: 0.6 },
        rateLimit: { enabled: false },
      },
    });

    await rRelay.registerEndpoint('relay.agent.bp-signal');
    // No subscriber so messages stay in new/

    const signals: Array<{ subject: string; signal: Signal }> = [];
    rRelay.onSignal('relay.agent.bp-signal', (subject, signal) => {
      signals.push({ subject, signal });
    });

    // Publish 3 messages to reach 3/5 = 0.6 pressure (equal to warning threshold)
    for (let i = 0; i < 3; i++) {
      await rRelay.publish('relay.agent.bp-signal', { i }, { from: 'relay.sender.bp-signal' });
    }

    // At 3/5 = 0.6 >= pressureWarningAt (0.6), a backpressure warning signal should be emitted
    // The signal is emitted during the 4th message's delivery check (when count is 3)
    // Actually, the count is checked BEFORE delivery, so:
    // Message 1: count=0 -> 0/5=0.0 < 0.6, no signal
    // Message 2: count=1 -> 1/5=0.2 < 0.6, no signal
    // Message 3: count=2 -> 2/5=0.4 < 0.6, no signal
    // Message 4: count=3 -> 3/5=0.6 >= 0.6, signal!
    await rRelay.publish(
      'relay.agent.bp-signal',
      { data: 'trigger-signal' },
      { from: 'relay.sender.bp-signal' }
    );

    expect(signals.length).toBeGreaterThanOrEqual(1);
    const bpSignal = signals.find((s) => s.signal.type === 'backpressure');
    expect(bpSignal).toBeDefined();
    expect(bpSignal!.signal.state).toBe('warning');
    expect(bpSignal!.signal.data).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Adapter delivery
// ---------------------------------------------------------------------------

describe('adapter delivery', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir('relay-adapter-test-');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('delivers to adapter when no Maildir endpoints match', async () => {
    const mockAdapter: AdapterRegistryLike = {
      setRelay: vi.fn(),
      deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 5 }),
      shutdown: vi.fn(),
    };
    const relayWithAdapter = new RelayCore({
      dataDir: tmpDir,
      adapterRegistry: mockAdapter,
    });

    const result = await relayWithAdapter.publish(
      'relay.agent.test-session',
      { content: 'hello' },
      { from: 'relay.test.sender' }
    );

    // relay.agent.* delivery is detached: publish returns acceptance
    // immediately while the agent turn runs in the background.
    expect(result.deliveredTo).toBe(1);
    expect(result.adapterResult).toMatchObject({ success: true });
    expect(mockAdapter.deliver).toHaveBeenCalledWith(
      'relay.agent.test-session',
      expect.objectContaining({ subject: 'relay.agent.test-session' }),
      // No `onHeld`: this publish names no reply subject, so there is no
      // person in a chat to hold the message for.
      undefined
    );

    await relayWithAdapter.close();
  });

  it('dead-letters when a detached agent delivery fails in the background', async () => {
    const failingAdapter: AdapterRegistryLike = {
      setRelay: vi.fn(),
      deliver: vi.fn().mockResolvedValue({
        success: false,
        error: 'connection refused',
      }),
      shutdown: vi.fn(),
    };
    const relayFailing = new RelayCore({
      dataDir: tmpDir,
      adapterRegistry: failingAdapter,
    });

    const result = await relayFailing.publish(
      'relay.agent.fail-session',
      { content: 'hello' },
      { from: 'relay.test.sender' }
    );

    // Detached delivery acknowledges acceptance; the failure surfaces
    // asynchronously as a dead letter for forensics.
    expect(result.deliveredTo).toBe(1);
    await vi.waitFor(async () => {
      const dead = await relayFailing.getDeadLetters();
      expect(dead.some((d) => d.reason.includes('adapter delivery failed'))).toBe(true);
    });

    await relayFailing.close();
  });

  it('dead-letters (not swallows) relay.agent.* messages when no adapter matches', async () => {
    // Regression: with no matching adapter (e.g. CCA failed to start),
    // detached delivery used to acknowledge acceptance anyway — publish
    // reported deliveredTo:1 and the message vanished with no DLQ entry.
    const emptyRegistry: AdapterRegistryLike = {
      setRelay: vi.fn(),
      deliver: vi.fn().mockResolvedValue(null),
      getBySubject: vi.fn().mockReturnValue(undefined),
      shutdown: vi.fn(),
    };
    const relayNoAdapter = new RelayCore({
      dataDir: tmpDir,
      adapterRegistry: emptyRegistry,
    });

    const result = await relayNoAdapter.publish(
      'relay.agent.orphaned-session',
      { content: 'hello' },
      { from: 'relay.test.sender' }
    );

    expect(result.deliveredTo).toBe(0);
    expect(emptyRegistry.deliver).not.toHaveBeenCalled();
    const dead = await relayNoAdapter.getDeadLetters();
    expect(dead.some((d) => d.envelope?.subject === 'relay.agent.orphaned-session')).toBe(true);

    await relayNoAdapter.close();
  });

  it('does NOT dead-letter when a non-agent adapter fails but Maildir delivered', async () => {
    const failingAdapter: AdapterRegistryLike = {
      setRelay: vi.fn(),
      deliver: vi.fn().mockResolvedValue({ success: false, error: 'down' }),
      shutdown: vi.fn(),
    };
    const relayPartial = new RelayCore({
      dataDir: tmpDir,
      adapterRegistry: failingAdapter,
    });
    // This test is about dead-lettering, not consent. A human-channel subject
    // needs a consent decision to reach delivery at all (a relay with no gate
    // installed denies them), so stand one in that says yes.
    relayPartial.setInitiateConsentGate(() => ({ allowed: true }));
    await relayPartial.registerEndpoint('relay.human.telegram.bot.chat');

    const result = await relayPartial.publish(
      'relay.human.telegram.bot.chat',
      { content: 'hello' },
      { from: 'relay.test.sender' }
    );

    expect(result.deliveredTo).toBe(1); // Maildir succeeded
    const dead = await relayPartial.getDeadLetters();
    expect(
      dead.filter((d) => d.envelope?.subject === 'relay.human.telegram.bot.chat')
    ).toHaveLength(0);

    await relayPartial.close();
  });

  it('passes adapter context through to adapter delivery', async () => {
    const mockAdapter: AdapterRegistryLike = {
      setRelay: vi.fn(),
      deliver: vi.fn().mockResolvedValue({ success: true }),
      shutdown: vi.fn(),
    };
    const mockContext: AdapterContext = {
      agent: { directory: '/tmp/test', runtime: 'claude-code' },
    };
    const relayWithContext = new RelayCore({
      dataDir: tmpDir,
      adapterRegistry: mockAdapter,
      adapterContextBuilder: () => mockContext,
    });

    await relayWithContext.publish(
      'relay.agent.ctx',
      { content: 'hi' },
      { from: 'relay.test.sender' }
    );

    expect(mockAdapter.deliver).toHaveBeenCalledWith(
      'relay.agent.ctx',
      expect.any(Object),
      mockContext
    );

    await relayWithContext.close();
  });
});
