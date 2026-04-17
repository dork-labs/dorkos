import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

import {
  TestModeRelayAdapter,
  TEST_MODE_MANIFEST,
  type TestModeRelayAdapterOptions,
} from '../test-mode-relay-adapter.js';
import type { RelayPublisher, MessageHandler, SignalHandler } from '../../../types.js';
import type { RuntimeOutboundEvent } from '../../runtime-adapter.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface CapturedPublish {
  subject: string;
  payload: unknown;
  from: string;
}

function makeFakeRelay(): { relay: RelayPublisher; calls: CapturedPublish[] } {
  const calls: CapturedPublish[] = [];
  const relay: RelayPublisher = {
    async publish(subject, payload, options) {
      calls.push({ subject, payload, from: options.from });
      return { messageId: `msg-${calls.length}`, deliveredTo: 1 };
    },
    onSignal(_pattern: string, _handler: SignalHandler) {
      return () => {};
    },
    subscribe(_pattern: string, _handler: MessageHandler) {
      return () => {};
    },
  };
  return { relay, calls };
}

function makeEnvelope(overrides?: Partial<RelayEnvelope>): RelayEnvelope {
  return {
    id: '01JABCDEF0000000000000001',
    subject: 'relay.agent.test-mode.session-1',
    from: 'relay.human.console.user',
    payload: 'hi',
    budget: { ttl: Date.now() + 60_000, hopCount: 0 },
    timestamp: new Date().toISOString(),
    ...overrides,
  } as RelayEnvelope;
}

function makeAdapter(overrides: Partial<TestModeRelayAdapterOptions> = {}): TestModeRelayAdapter {
  const scenarios: RuntimeOutboundEvent[] = overrides.scenarios ?? [
    { type: 'session_status', data: { sessionId: 'session-1' } },
    { type: 'text_delta', data: { text: 'Echo: hi' } },
    { type: 'done', data: { sessionId: 'session-1' } },
  ];
  return new TestModeRelayAdapter({ ...overrides, scenarios });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TestModeRelayAdapter', () => {
  it('exposes the runtime-scoped subject prefix (no legacy fallback)', () => {
    const adapter = makeAdapter();
    expect(adapter.subjectPrefix).toEqual(['relay.agent.test-mode.']);
  });

  it('start/stop transitions status and is idempotent on stop', async () => {
    const { relay } = makeFakeRelay();
    const adapter = makeAdapter();

    expect(adapter.getStatus().state).toBe('disconnected');
    await adapter.start(relay);
    expect(adapter.getStatus().state).toBe('connected');
    expect(adapter.getStatus().startedAt).toBeTypeOf('string');

    await adapter.stop();
    expect(adapter.getStatus().state).toBe('disconnected');
    // Second stop must not throw.
    await adapter.stop();
  });

  it('publishes each scenario event back to envelope.replyTo', async () => {
    const { relay, calls } = makeFakeRelay();
    const adapter = makeAdapter();
    await adapter.start(relay);

    const envelope = makeEnvelope({ replyTo: 'relay.human.console.user' });
    const result = await adapter.deliver(envelope.subject, envelope);

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.subject === 'relay.human.console.user')).toBe(true);
    expect(calls.map((c) => (c.payload as RuntimeOutboundEvent).type)).toEqual([
      'session_status',
      'text_delta',
      'done',
    ]);
    expect(calls[0]?.from).toBe('test-mode.session-1');
  });

  it('skips publishing when no reply target is available', async () => {
    const { relay, calls } = makeFakeRelay();
    const adapter = makeAdapter();
    await adapter.start(relay);

    const envelope = makeEnvelope(); // no replyTo, no defaultReplySubject
    const result = await adapter.deliver(envelope.subject, envelope);

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('honors defaultReplySubject when envelope.replyTo is missing', async () => {
    const { relay, calls } = makeFakeRelay();
    const adapter = makeAdapter({ defaultReplySubject: 'relay.inbox.test' });
    await adapter.start(relay);

    await adapter.deliver('relay.agent.test-mode.session-2', makeEnvelope({ replyTo: undefined }));

    expect(calls.every((c) => c.subject === 'relay.inbox.test')).toBe(true);
  });

  it('returns a structured error when sessionId cannot be extracted', async () => {
    const { relay } = makeFakeRelay();
    const adapter = makeAdapter();
    await adapter.start(relay);

    const result = await adapter.deliver(
      'relay.agent.test-mode.', // trailing dot → parser rejects
      makeEnvelope({ subject: 'relay.agent.test-mode.' })
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Could not extract sessionId/);
  });

  it('increments inbound/outbound counters as expected', async () => {
    const { relay } = makeFakeRelay();
    const adapter = makeAdapter();
    await adapter.start(relay);

    await adapter.deliver(
      'relay.agent.test-mode.session-3',
      makeEnvelope({ subject: 'relay.agent.test-mode.session-3', replyTo: 'relay.inbox.x' })
    );

    const status = adapter.getStatus();
    expect(status.messageCount.inbound).toBe(1);
    expect(status.messageCount.outbound).toBe(3);
    expect(status.errorCount).toBe(0);
  });

  it('exposes a static manifest for AdapterManager registration', () => {
    expect(TEST_MODE_MANIFEST.type).toBe('test-mode');
    expect(TEST_MODE_MANIFEST.builtin).toBe(true);
    expect(TEST_MODE_MANIFEST.configFields).toEqual([]);
  });

  it('does not publish after stop()', async () => {
    const { relay, calls } = makeFakeRelay();
    const adapter = makeAdapter();
    await adapter.start(relay);
    await adapter.stop();

    const spy = vi.spyOn(relay, 'publish');
    await adapter.deliver(
      'relay.agent.test-mode.session-4',
      makeEnvelope({ replyTo: 'relay.inbox.x' })
    );
    expect(spy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('has no Claude-specific imports (module-source assertion)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sourcePath = resolve(here, '..', 'test-mode-relay-adapter.ts');
    const src = readFileSync(sourcePath, 'utf8');

    expect(src).not.toMatch(/@anthropic-ai\/claude-agent-sdk/);
    expect(src).not.toMatch(/claude-code/i);
    expect(src.toLowerCase()).not.toMatch(/claude/);
  });
});
