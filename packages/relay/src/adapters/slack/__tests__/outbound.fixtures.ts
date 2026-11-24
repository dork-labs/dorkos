/**
 * Shared Slack client doubles and a `deliver` helper for the Slack outbound
 * test files. Payload parsing and subject decoding run for real.
 */
import { vi, type Mock } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { deliverMessage, createSlackOutboundState } from '../outbound.js';
import type { ActiveStream } from '../outbound.js';
import type { AdapterOutboundCallbacks } from '../../../types.js';
import { SlackThreadIdCodec } from '../../../lib/thread-id.js';
import type { ThreadParticipationTracker } from '../thread-tracker.js';
import { createSlackPresenceState } from '../presence.js';
import type { SlackPresenceState } from '../presence.js';

/** Shared codec for tests — no instance ID so prefix is `relay.human.slack`. */
const testCodec = new SlackThreadIdCodec();

export const mockPostMessage: Mock = vi.fn().mockResolvedValue({ ts: 'msg-ts-1' });
export const mockChatUpdate: Mock = vi.fn().mockResolvedValue({ ts: 'msg-ts-1' });
export const mockStartStream: Mock = vi.fn().mockResolvedValue({ stream_id: 'stream-123' });
export const mockAppendStream: Mock = vi.fn().mockResolvedValue({ ok: true });
export const mockStopStream: Mock = vi.fn().mockResolvedValue({ ok: true });
export const mockReactionsAdd: Mock = vi.fn().mockResolvedValue({ ok: true });
export const mockReactionsRemove: Mock = vi.fn().mockResolvedValue({ ok: true });
export const mockSetStatus: Mock = vi.fn().mockResolvedValue({ ok: true });

/**
 * Build a WebClient test double with chat and reactions methods wired.
 * The cast through `unknown` is intentional: the real WebClient has dozens
 * of API groups we don't need, and a partial stub is cleaner than
 * implementing the full interface.
 */
function buildMockClient(): WebClient {
  const stub = {
    chat: {
      postMessage: mockPostMessage,
      update: mockChatUpdate,
      startStream: mockStartStream,
      appendStream: mockAppendStream,
      stopStream: mockStopStream,
    },
    reactions: { add: mockReactionsAdd, remove: mockReactionsRemove },
    assistant: { threads: { setStatus: mockSetStatus } },
  };
  return stub as unknown as WebClient;
}

function createCallbacks(): AdapterOutboundCallbacks {
  return {
    trackOutbound: vi.fn(),
    recordError: vi.fn(),
  };
}

export function createEnvelope(subject: string, payload: unknown, from = 'relay.agent.backend') {
  return {
    id: 'env-01',
    subject,
    from,
    budget: {
      hopCount: 0,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 3_600_000,
      callBudgetRemaining: 10,
    },
    createdAt: new Date().toISOString(),
    payload,
  };
}

/** A standard or stream-event envelope on the default DM channel. */
export function env(payload: unknown, from?: string) {
  return createEnvelope('relay.human.slack.D123', payload, from);
}

/** A `text_delta` stream event on the default DM, optionally threaded. */
export function textDelta(text: string, ts?: string) {
  return env({ type: 'text_delta', data: { text }, ...(ts ? { platformData: { ts } } : {}) });
}

/**
 * Outbound state for the current test.
 *
 * Shared across `deliver()` calls the way the real adapter shares it: one
 * instance per adapter, for its whole life. A fresh one per call would hide
 * anything that spans two events of the same turn — which is most of what this
 * module does.
 */
export const h = {
  approvalState: createSlackOutboundState(),
  client: undefined as unknown as WebClient,
  streamState: new Map<string, ActiveStream>(),
  callbacks: undefined as unknown as AdapterOutboundCallbacks,
  /** What `Date.now()` returns; tests advance it for the throttle window. */
  now: 1_000_000,
};

/** Fresh client, stream state, outbound state and callbacks, with `Date.now` pinned. */
export function resetOutboundHarness(): typeof h {
  vi.clearAllMocks();
  h.client = buildMockClient();
  h.streamState = new Map();
  h.approvalState = createSlackOutboundState();
  h.callbacks = createCallbacks();
  h.now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => h.now);
  return h;
}

interface DeliverOptions {
  client?: WebClient | null;
  streaming?: boolean;
  typingIndicator?: 'none' | 'reaction';
  nativeStreaming?: boolean;
  presence?: SlackPresenceState;
  threadTracker?: ThreadParticipationTracker;
}

/** Deliver one envelope to its own subject with this test's shared state. */
export function deliver(envelope: ReturnType<typeof createEnvelope>, opts: DeliverOptions = {}) {
  return deliverMessage({
    adapterId: 'slack',
    subject: envelope.subject,
    envelope,
    client: opts.client === undefined ? h.client : opts.client,
    streamState: h.streamState,
    presence: opts.presence ?? createSlackPresenceState(),
    botUserId: 'UBOTID',
    callbacks: h.callbacks,
    streaming: opts.streaming ?? true,
    nativeStreaming: opts.nativeStreaming ?? false,
    typingIndicator: opts.typingIndicator ?? 'none',
    approvalState: h.approvalState,
    codec: testCodec,
    threadTracker: opts.threadTracker,
  });
}
