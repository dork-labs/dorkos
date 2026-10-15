import crypto from 'node:crypto';
import { vi } from 'vitest';
import type { InterruptOutcome, InterruptReason, InterruptReceipt } from '@dorkos/shared/types';
import {
  CONNECTION_GONE_AGENT_COPY,
  CONNECTION_READINESS_COPY,
  ConnectionReadinessSchema,
  disconnectStuckOwnerLine,
  type ConnectionReadiness,
} from '@dorkos/shared/connector-schemas';
import type { RelayAdapter, AdapterStatus } from '@dorkos/relay';
import type { ObservedChat, AdapterBinding } from '@dorkos/shared/relay-schemas';

/**
 * Generate a valid HMAC-SHA256 signature for webhook testing.
 *
 * Produces headers that `WebhookAdapter.handleInbound()` will accept, using
 * the same Stripe-style format: `{timestamp}.{body}`.
 *
 * @param body - The raw request body string to sign
 * @param secret - The HMAC secret to sign with
 * @param timestamp - Optional Unix timestamp in seconds (defaults to now)
 * @returns Object with `signature`, `timestamp`, and `nonce` header values
 */
export function signPayload(
  body: string,
  secret: string,
  timestamp?: number
): { signature: string; timestamp: string; nonce: string } {
  const ts = String(timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const message = `${ts}.${body}`;
  const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return { signature, timestamp: ts, nonce };
}

/**
 * Create a mock ObservedChat with sensible defaults.
 *
 * @param overrides - Partial overrides for the chat fields
 */
export function createMockObservedChat(overrides: Partial<ObservedChat> = {}): ObservedChat {
  return {
    chatId: '12345',
    displayName: 'Test Chat',
    channelType: 'dm',
    lastMessageAt: new Date().toISOString(),
    messageCount: 5,
    ...overrides,
  };
}

/**
 * Create a mock AdapterBinding with sensible defaults.
 *
 * @param overrides - Partial overrides for the binding fields
 */
export function createMockBinding(overrides: Partial<AdapterBinding> = {}): AdapterBinding {
  return {
    id: crypto.randomUUID(),
    adapterId: 'telegram-1',
    agentId: 'agent-1',
    sessionStrategy: 'per-chat',
    label: '',
    permissionMode: 'acceptEdits',
    enabled: true,
    canInitiate: false,
    canReply: true,
    canReceive: true,
    notifyOnTaskComplete: true,
    bridge: 'off',
    roomId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a mock RelayAdapter with all methods stubbed via vi.fn().
 *
 * @param overrides - Partial overrides for adapter properties and methods
 */
export function createMockAdapter(overrides: Partial<RelayAdapter> = {}): RelayAdapter {
  const defaultStatus: AdapterStatus = {
    state: 'connected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  };

  return {
    id: 'mock-adapter',
    subjectPrefix: 'relay.test.mock',
    displayName: 'Mock Adapter',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    deliver: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue(defaultStatus),
    ...overrides,
  };
}

/**
 * Build one {@link InterruptReceipt} for a test.
 *
 * The stop vocabulary is five outcomes and six reasons, and a test that spells
 * a literal out inline is a test that can spell one WRONG — a `not-running`
 * carrying `refused` type-checks perfectly and means nothing. This picks each
 * outcome's canonical reason so a caller states only what it cares about.
 *
 * @param outcome - Which of the five endings to stage
 * @param overrides - `runtime` (defaults to `'fake'`) and an explicit `reason`,
 *   for the cells where the outcome alone carries the fact — a bare `closed`,
 *   which is what a runtime with no graceful path to abandon answers
 */
export function mockInterruptReceipt(
  outcome: InterruptOutcome,
  overrides: { runtime?: string; reason?: InterruptReason | null } = {}
): InterruptReceipt {
  const canonicalReason: Record<InterruptOutcome, InterruptReason | undefined> = {
    acked: undefined,
    closed: 'ack-timeout',
    'not-running': 'no-open-turn',
    unconfirmed: 'runtime-declined',
    failed: 'delivery-failed',
  };
  const reason = overrides.reason === undefined ? canonicalReason[outcome] : overrides.reason;
  return {
    outcome,
    ...(reason ? { reason } : {}),
    runtime: overrides.runtime ?? 'fake',
  };
}

/**
 * A connected account's server readiness for client fixtures: ready unless
 * overridden. Client code renders readiness and never derives it, so a fixture
 * names the state it wants the surface to show; the server's own table
 * (`deriveConnectionReadiness`) is tested on its own. Words come from the one
 * copy table unless given, and the result is checked against the schema, so a
 * fixture can never hold a readiness the server could not send.
 *
 * @param overrides - The state, reason, fix or copy to use instead.
 */
export function createMockConnectionReadiness(
  overrides: Partial<ConnectionReadiness> = {}
): ConnectionReadiness {
  const reason = overrides.reason ?? 'usable';
  const copy =
    overrides.copy ??
    (reason === 'disconnect_stuck'
      ? { owner: disconnectStuckOwnerLine('unconfirmed'), agent: CONNECTION_GONE_AGENT_COPY }
      : CONNECTION_READINESS_COPY[reason]);
  return ConnectionReadinessSchema.parse({ state: 'ready', ...overrides, reason, copy });
}
