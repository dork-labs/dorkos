/**
 * Relay-level wrapper around `TestModeAdapter`.
 *
 * Exists to prove, on every CI run, that the shared `RuntimeAdapter` + relay
 * composition is genuinely runtime-agnostic. Registers as a `RelayAdapter`
 * handling the runtime-scoped subject prefix `relay.agent.test-mode.` and
 * forwards scripted scenario events back to `envelope.replyTo` (when
 * provided) so integration tests can observe the full relay→adapter→relay
 * loop without booting the default agent runtime's SDK.
 *
 * Not for production use. See ADR 0257.
 *
 * Import-hygiene contract (see sibling `test-mode-adapter.test.ts`): this
 * module must stay free of runtime-specific vendor imports or vocabulary.
 * If it would need one, the shared base is leaking and must be fixed first.
 *
 * @module relay/adapters/test-mode/test-mode-relay-adapter
 */

import type { RelayEnvelope, AdapterManifest } from '@dorkos/shared/relay-schemas';
import type {
  AdapterContext,
  AdapterStatus,
  DeliveryResult,
  RelayAdapter,
  RelayPublisher,
} from '../../types.js';
import { extractSessionIdFromSubject } from '../../lib/subjects.js';
import { TestModeAdapter, type TestModeAdapterOptions } from './test-mode-adapter.js';
import type { RuntimeOutboundEvent } from '../runtime-adapter.js';

/** Subject prefix this adapter owns — runtime-scoped shape only. */
const TEST_MODE_SUBJECT_PREFIX = 'relay.agent.test-mode.' as const;

/** Static manifest for AdapterManager catalog registration. */
export const TEST_MODE_MANIFEST: AdapterManifest = {
  type: 'test-mode',
  displayName: 'Test Mode',
  description: 'Scripted relay adapter used as a CI integration fixture. Not for production use.',
  iconId: 'test-mode',
  category: 'internal',
  builtin: true,
  multiInstance: false,
  configFields: [],
};

/** Construction options for {@link TestModeRelayAdapter}. */
export interface TestModeRelayAdapterOptions extends TestModeAdapterOptions {
  /** Adapter ID surfaced to `AdapterRegistry`. Defaults to `'test-mode'`. */
  readonly id?: string;
  /**
   * Default reply subject used when an inbound envelope omits `replyTo`.
   * Useful in tests that do not set a reply target explicitly.
   */
  readonly defaultReplySubject?: string;
}

/**
 * Relay-level adapter that drives a {@link TestModeAdapter} per delivery.
 *
 * Registers under a single prefix (`relay.agent.test-mode.`) so it never
 * competes with the default runtime's adapter via the longest-matching-
 * prefix-wins rule in {@link AdapterRegistry.getBySubject}.
 */
export class TestModeRelayAdapter implements RelayAdapter {
  readonly id: string;
  readonly subjectPrefix = [TEST_MODE_SUBJECT_PREFIX] as const;
  readonly displayName = 'Test Mode';

  private readonly runtime: PublishingTestModeAdapter;
  private readonly defaultReplySubject: string | undefined;
  private relay: RelayPublisher | null = null;
  private status: AdapterStatus = {
    state: 'disconnected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  };

  constructor(options: TestModeRelayAdapterOptions) {
    this.id = options.id ?? 'test-mode';
    this.defaultReplySubject = options.defaultReplySubject;
    this.runtime = new PublishingTestModeAdapter({ runtimeType: 'test-mode' }, options, (event) =>
      this.publish(event)
    );
  }

  async start(relay: RelayPublisher): Promise<void> {
    this.relay = relay;
    this.status = {
      state: 'connected',
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
      startedAt: new Date().toISOString(),
    };
  }

  async stop(): Promise<void> {
    this.relay = null;
    this.runtime.resetQueues();
    this.status = { ...this.status, state: 'disconnected' };
  }

  getStatus(): AdapterStatus {
    return { ...this.status };
  }

  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    _context?: AdapterContext
  ): Promise<DeliveryResult> {
    const startTime = Date.now();
    this.status = {
      ...this.status,
      messageCount: {
        ...this.status.messageCount,
        inbound: this.status.messageCount.inbound + 1,
      },
    };

    const sessionId = extractSessionIdFromSubject(subject);
    if (!sessionId) {
      return {
        success: false,
        error: `Could not extract sessionId from subject: ${subject}`,
        durationMs: Date.now() - startTime,
      };
    }

    const replySubject = envelope.replyTo ?? this.defaultReplySubject;
    this.runtime.setReplyTarget(sessionId, replySubject);
    this.runtime.setInboundEnvelope(sessionId, envelope);

    try {
      const content = typeof envelope.payload === 'string' ? envelope.payload : '';
      const result = await this.runtime.streamMessageFor(sessionId, content);
      if (!result.success) {
        this.status = {
          ...this.status,
          errorCount: this.status.errorCount + 1,
          lastError: result.error ?? 'test-mode stream failed',
          lastErrorAt: new Date().toISOString(),
        };
      }
      return {
        success: result.success,
        durationMs: result.durationMs,
        ...(result.error ? { error: result.error } : {}),
      };
    } finally {
      this.runtime.clearReplyTarget(sessionId);
    }
  }

  /** Publish a single normalized event back to the current reply subject. */
  private async publish(event: PublishedEvent): Promise<void> {
    const { replySubject, payload } = event;
    if (!this.relay || !replySubject) return;
    await this.relay.publish(replySubject, payload, {
      from: `test-mode.${event.sessionId}`,
    });
    this.status = {
      ...this.status,
      messageCount: {
        ...this.status.messageCount,
        outbound: this.status.messageCount.outbound + 1,
      },
    };
  }
}

/** Internal event shape passed to the adapter's publish hook. */
interface PublishedEvent {
  readonly sessionId: string;
  readonly replySubject: string | undefined;
  readonly payload: RuntimeOutboundEvent;
}

/**
 * `TestModeAdapter` subclass that captures the per-session reply target
 * and forwards each normalized event to the injected publish hook.
 *
 * Kept private to this module: the hygiene contract on `TestModeAdapter`
 * must not leak into the relay-integration layer.
 */
class PublishingTestModeAdapter extends TestModeAdapter {
  private readonly replyTargets = new Map<string, string | undefined>();
  private readonly inboundEnvelopes = new Map<string, RelayEnvelope>();
  private readonly publisher: (event: PublishedEvent) => Promise<void>;

  constructor(
    ctx: ConstructorParameters<typeof TestModeAdapter>[0],
    options: TestModeAdapterOptions,
    publisher: (event: PublishedEvent) => Promise<void>
  ) {
    super(ctx, options);
    this.publisher = publisher;
  }

  setReplyTarget(sessionId: string, replySubject: string | undefined): void {
    this.replyTargets.set(sessionId, replySubject);
  }

  clearReplyTarget(sessionId: string): void {
    this.replyTargets.delete(sessionId);
    this.inboundEnvelopes.delete(sessionId);
  }

  setInboundEnvelope(sessionId: string, envelope: RelayEnvelope): void {
    this.inboundEnvelopes.set(sessionId, envelope);
  }

  /** Drive the base pipeline for a single inbound message. */
  async streamMessageFor(
    sessionId: string,
    content: string
  ): Promise<{ success: boolean; error?: string; durationMs: number }> {
    const result = await this.streamMessage({ sessionId, content });
    return {
      success: result.success,
      ...(result.error ? { error: result.error } : {}),
      durationMs: result.durationMs,
    };
  }

  /** Drop all per-session queues. Called on adapter stop. */
  resetQueues(): void {
    this.clearSessionQueues();
    this.replyTargets.clear();
    this.inboundEnvelopes.clear();
  }

  protected override async deliver(event: RuntimeOutboundEvent): Promise<void> {
    const sessionId = this.findSessionIdFor(event);
    if (!sessionId) return;
    const replySubject = this.replyTargets.get(sessionId);
    await this.publisher({ sessionId, replySubject, payload: event });
  }

  /**
   * Best-effort reverse-lookup of the current session id for an event.
   *
   * `TestModeAdapter` only ever runs one in-flight `streamMessage` per session
   * (base-class invariant), so when exactly one reply target is set we can
   * assign events to it unambiguously. In the rare case of multiple concurrent
   * sessions we fall back to the first entry — the fixture's scenarios should
   * not depend on cross-session event interleaving.
   */
  private findSessionIdFor(_event: RuntimeOutboundEvent): string | undefined {
    const keys = this.replyTargets.keys();
    const first = keys.next();
    return first.done ? undefined : first.value;
  }
}
