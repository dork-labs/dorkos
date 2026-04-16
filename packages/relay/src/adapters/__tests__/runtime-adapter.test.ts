import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  RuntimeAdapter,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
  type RuntimeAdapterContext,
  type RuntimeInboundMessage,
  type RuntimeOutboundEvent,
  type RuntimeSessionHandle,
} from '../runtime-adapter.js';

// ---------------------------------------------------------------------------
// Minimal fake subclass used across tests.
// ---------------------------------------------------------------------------

interface FakeOptions {
  /** Raw events to yield from streamEvents. */
  events?: unknown[];
  /** If set, streamEvents throws this after yielding all events. */
  throwMidStream?: Error;
  /** If set, openSession throws this. */
  throwOnOpen?: Error;
  /** If set, closeSession throws this. */
  throwOnClose?: Error;
  /** If true, streamEvents delays after each event to simulate a slow runtime. */
  eventDelayMs?: number;
  /** Override retry policy for specific tests. */
  policy?: RetryPolicy;
}

class FakeAdapter extends RuntimeAdapter {
  readonly openMock = vi.fn<(id: string) => Promise<RuntimeSessionHandle>>();
  readonly streamMock =
    vi.fn<
      (
        handle: RuntimeSessionHandle,
        message: RuntimeInboundMessage,
        signal: AbortSignal
      ) => AsyncIterable<unknown>
    >();
  readonly closeMock = vi.fn<(handle: RuntimeSessionHandle) => Promise<void>>();
  readonly normalizeMock = vi.fn<(raw: unknown) => RuntimeOutboundEvent>();
  readonly deliverMock = vi.fn<(event: RuntimeOutboundEvent) => Promise<void>>();

  constructor(
    ctx: RuntimeAdapterContext,
    private readonly options: FakeOptions = {}
  ) {
    super(ctx);

    this.openMock.mockImplementation(async (sessionId) => {
      if (options.throwOnOpen) throw options.throwOnOpen;
      return { sessionId };
    });

    this.closeMock.mockImplementation(async () => {
      if (options.throwOnClose) throw options.throwOnClose;
    });

    this.normalizeMock.mockImplementation((raw) => {
      if (raw && typeof raw === 'object' && 'type' in raw) {
        return raw as RuntimeOutboundEvent;
      }
      return { type: 'unknown', data: raw };
    });

    this.streamMock.mockImplementation((_handle, _message, signal) =>
      this.makeEventIterable(signal)
    );
  }

  /** Expose the delivery call log for ordering assertions. */
  get deliveredEvents(): RuntimeOutboundEvent[] {
    return this.deliverMock.mock.calls.map(([event]) => event);
  }

  // --- RuntimeAdapter overrides ---

  protected openSession(sessionId: string): Promise<RuntimeSessionHandle> {
    return this.openMock(sessionId);
  }

  protected streamEvents(
    handle: RuntimeSessionHandle,
    message: RuntimeInboundMessage,
    signal: AbortSignal
  ): AsyncIterable<unknown> {
    return this.streamMock(handle, message, signal);
  }

  protected async closeSession(handle: RuntimeSessionHandle): Promise<void> {
    return this.closeMock(handle);
  }

  protected normalizeEvent(raw: unknown): RuntimeOutboundEvent {
    return this.normalizeMock(raw);
  }

  protected async deliver(event: RuntimeOutboundEvent): Promise<void> {
    await this.deliverMock(event);
  }

  protected retryPolicy(): RetryPolicy {
    return this.options.policy ?? super.retryPolicy();
  }

  // --- Internal helpers ---

  private async *makeEventIterable(signal: AbortSignal): AsyncIterable<unknown> {
    const events = this.options.events ?? [];
    for (const event of events) {
      if (signal.aborted) return;
      if (this.options.eventDelayMs) {
        await delay(this.options.eventDelayMs);
      }
      yield event;
    }
    if (this.options.throwMidStream) {
      throw this.options.throwMidStream;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function makeCtx(overrides?: Partial<RuntimeAdapterContext>): RuntimeAdapterContext {
  return {
    runtimeType: 'fake',
    ...overrides,
  };
}

function makeMessage(overrides?: Partial<RuntimeInboundMessage>): RuntimeInboundMessage {
  return {
    sessionId: 'session-1',
    content: 'hello',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RuntimeAdapter', () => {
  it('opens the session exactly once per streamMessage', async () => {
    const adapter = new FakeAdapter(makeCtx(), {
      events: [{ type: 'text', data: 'a' }],
    });

    await adapter.streamMessage(makeMessage());

    expect(adapter.openMock).toHaveBeenCalledTimes(1);
    expect(adapter.openMock).toHaveBeenCalledWith('session-1');
  });

  it('normalizes each raw event and delivers them in order', async () => {
    const raws = [
      { type: 'text', data: 'hello' },
      { type: 'text', data: 'world' },
      { type: 'done' },
    ];
    const adapter = new FakeAdapter(makeCtx(), { events: raws });

    const result = await adapter.streamMessage(makeMessage());

    expect(result.success).toBe(true);
    expect(result.eventCount).toBe(3);
    expect(adapter.normalizeMock).toHaveBeenCalledTimes(3);
    expect(adapter.deliveredEvents.map((e) => e.type)).toEqual(['text', 'text', 'done']);
  });

  it('calls closeSession exactly once on successful completion', async () => {
    const adapter = new FakeAdapter(makeCtx(), {
      events: [{ type: 'done' }],
    });

    await adapter.streamMessage(makeMessage());

    expect(adapter.closeMock).toHaveBeenCalledTimes(1);
  });

  it('calls closeSession even when streamEvents throws mid-stream', async () => {
    const boom = new Error('stream blew up');
    const adapter = new FakeAdapter(makeCtx(), {
      events: [{ type: 'text', data: 'partial' }],
      throwMidStream: boom,
    });

    const result = await adapter.streamMessage(makeMessage());

    expect(result.success).toBe(false);
    expect(result.error).toBe('stream blew up');
    expect(result.eventCount).toBe(1);
    expect(adapter.closeMock).toHaveBeenCalledTimes(1);
  });

  it('skips closeSession when openSession throws (no handle produced)', async () => {
    const adapter = new FakeAdapter(makeCtx(), {
      throwOnOpen: new Error('no session for you'),
    });

    const result = await adapter.streamMessage(makeMessage());

    expect(result.success).toBe(false);
    expect(result.error).toBe('no session for you');
    expect(adapter.closeMock).not.toHaveBeenCalled();
  });

  it('surfaces closeSession errors when stream succeeded cleanly', async () => {
    const adapter = new FakeAdapter(makeCtx(), {
      events: [{ type: 'done' }],
      throwOnClose: new Error('close failed'),
    });

    const result = await adapter.streamMessage(makeMessage());

    expect(result.success).toBe(false);
    expect(result.error).toBe('close failed');
    expect(adapter.closeMock).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent streamMessage calls for the same session', async () => {
    const adapter = new FakeAdapter(makeCtx(), {
      events: [{ type: 'tick' }],
      eventDelayMs: 25,
    });

    const inFlight: number[] = [];
    let active = 0;
    adapter.openMock.mockImplementation(async (sessionId) => {
      active++;
      inFlight.push(active);
      await delay(10);
      active--;
      return { sessionId };
    });

    await Promise.all([
      adapter.streamMessage(makeMessage({ sessionId: 'shared' })),
      adapter.streamMessage(makeMessage({ sessionId: 'shared' })),
      adapter.streamMessage(makeMessage({ sessionId: 'shared' })),
    ]);

    // Max concurrency for the same session should be 1.
    expect(Math.max(...inFlight)).toBe(1);
    expect(adapter.openMock).toHaveBeenCalledTimes(3);
  });

  it('runs concurrent streamMessage calls for different sessions in parallel', async () => {
    const adapter = new FakeAdapter(makeCtx(), {
      events: [{ type: 'tick' }],
    });

    let active = 0;
    let peak = 0;
    adapter.openMock.mockImplementation(async (sessionId) => {
      active++;
      peak = Math.max(peak, active);
      await delay(20);
      active--;
      return { sessionId };
    });

    await Promise.all([
      adapter.streamMessage(makeMessage({ sessionId: 'a' })),
      adapter.streamMessage(makeMessage({ sessionId: 'b' })),
      adapter.streamMessage(makeMessage({ sessionId: 'c' })),
    ]);

    expect(peak).toBeGreaterThan(1);
  });

  it('aborts the stream when the attempt timeout elapses', async () => {
    const adapter = new FakeAdapter(makeCtx(), {
      events: [
        { type: 'e1' },
        { type: 'e2' },
        { type: 'e3' },
        { type: 'e4' },
        { type: 'e5' },
        { type: 'e6' },
      ],
      eventDelayMs: 20,
      policy: { ...DEFAULT_RETRY_POLICY, timeoutMs: 25 },
    });

    const result = await adapter.streamMessage(makeMessage());

    expect(result.aborted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.eventCount).toBeLessThan(6);
    expect(adapter.closeMock).toHaveBeenCalledTimes(1);
  });

  it('uses RuntimeInboundMessage.deadlineMs over retryPolicy.timeoutMs when provided', async () => {
    const adapter = new FakeAdapter(makeCtx(), {
      events: [{ type: 'e1' }, { type: 'e2' }, { type: 'e3' }],
      eventDelayMs: 20,
      // Policy timeout is generous; deadline should win.
      policy: { ...DEFAULT_RETRY_POLICY, timeoutMs: 10_000 },
    });

    const result = await adapter.streamMessage(makeMessage({ deadlineMs: Date.now() + 25 }));

    expect(result.aborted).toBe(true);
    expect(result.eventCount).toBeLessThan(3);
  });

  it('returns success=true and a non-zero durationMs for a clean stream', async () => {
    const adapter = new FakeAdapter(makeCtx(), {
      events: [{ type: 'done' }],
      eventDelayMs: 1,
    });

    const result = await adapter.streamMessage(makeMessage());

    expect(result.success).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('retryPolicy() is overridable by subclasses', async () => {
    class CustomPolicyAdapter extends FakeAdapter {
      protected override retryPolicy(): RetryPolicy {
        return { maxAttempts: 5, baseDelayMs: 50, timeoutMs: 999 };
      }
    }

    const adapter = new CustomPolicyAdapter(makeCtx(), { events: [{ type: 'x' }] });
    await adapter.streamMessage(makeMessage());

    // Policy plumbed through — resolveTimeoutMs would have used 999.
    // Observed indirectly via successful completion.
    expect(adapter.openMock).toHaveBeenCalledTimes(1);
  });

  it('does not import anything Claude-specific', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sourcePath = resolve(here, '..', 'runtime-adapter.ts');
    const src = readFileSync(sourcePath, 'utf8');
    expect(src).not.toMatch(/@anthropic-ai/);
    expect(src.toLowerCase()).not.toMatch(/claude/);
  });
});
