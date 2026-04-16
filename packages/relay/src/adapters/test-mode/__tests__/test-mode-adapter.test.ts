import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

import { TestModeAdapter, type TestModeAdapterOptions } from '../test-mode-adapter.js';
import type {
  RuntimeAdapterContext,
  RuntimeInboundMessage,
  RuntimeOutboundEvent,
  RuntimeSessionHandle,
} from '../../runtime-adapter.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Observable subclass that captures every normalized event the base pipeline
 * hands to `deliver()`. The base class's `deliver()` is a no-op by default;
 * overriding here is the sanctioned way to witness the pipeline output.
 */
class ObservableTestModeAdapter extends TestModeAdapter {
  public readonly deliveries: RuntimeOutboundEvent[] = [];

  protected override async deliver(event: RuntimeOutboundEvent): Promise<void> {
    this.deliveries.push(event);
  }

  /** Expose the protected `openSession` hook for direct-invocation tests. */
  public async openForTest(sessionId: string): Promise<RuntimeSessionHandle> {
    return this.openSession(sessionId);
  }
}

function makeCtx(overrides?: Partial<RuntimeAdapterContext>): RuntimeAdapterContext {
  return { runtimeType: 'test-mode', ...overrides };
}

function makeMessage(overrides?: Partial<RuntimeInboundMessage>): RuntimeInboundMessage {
  return { sessionId: 'session-1', content: 'hello', ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TestModeAdapter', () => {
  it('streams scripted scenarios through the base pipeline end to end', async () => {
    const scenarios: RuntimeOutboundEvent[] = [
      { type: 'session_status', data: { sessionId: 'test-mode' } },
      { type: 'text_delta', data: { text: 'Echo: hello' } },
      { type: 'done', data: { sessionId: 'test-mode' } },
    ];
    const options: TestModeAdapterOptions = { scenarios };
    const adapter = new ObservableTestModeAdapter(makeCtx(), options);

    const result = await adapter.streamMessage(makeMessage());

    expect(result.success).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.eventCount).toBe(3);
    expect(adapter.deliveries.map((e) => e.type)).toEqual(['session_status', 'text_delta', 'done']);
    expect(adapter.deliveries.some((e) => e.type === 'text_delta')).toBe(true);
  });

  it('openSession returns a handle keyed by sessionId', async () => {
    const adapter = new ObservableTestModeAdapter(makeCtx(), { scenarios: [] });

    const handle = await adapter.openForTest('s-xyz');

    expect(handle).toEqual({ sessionId: 's-xyz' });
  });

  it('respects AbortSignal mid-stream when a deadline elapses', async () => {
    const scenarios: RuntimeOutboundEvent[] = Array.from({ length: 6 }, (_, i) => ({
      type: 'text_delta',
      data: { text: `chunk-${i}` },
    }));
    const adapter = new ObservableTestModeAdapter(makeCtx(), {
      scenarios,
      eventLatencyMs: 20,
    });

    // Deadline = 25ms — only a small prefix of the 6-event stream should land.
    const result = await adapter.streamMessage(makeMessage({ deadlineMs: Date.now() + 25 }));

    expect(result.aborted).toBe(true);
    expect(result.success).toBe(false);
    expect(adapter.deliveries.length).toBeLessThan(scenarios.length);
  });

  it('closeSession is a no-op (no errors on clean shutdown)', async () => {
    const adapter = new ObservableTestModeAdapter(makeCtx(), {
      scenarios: [{ type: 'done' }],
    });

    const result = await adapter.streamMessage(makeMessage());

    // A no-op close must not surface as an error in the result.
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('has no Claude-specific imports (module-source assertion)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sourcePath = resolve(here, '..', 'test-mode-adapter.ts');
    const src = readFileSync(sourcePath, 'utf8');

    expect(src).not.toMatch(/@anthropic-ai\/claude-agent-sdk/);
    expect(src).not.toMatch(/claude-code/i);
    expect(src.toLowerCase()).not.toMatch(/claude/);
  });
});
