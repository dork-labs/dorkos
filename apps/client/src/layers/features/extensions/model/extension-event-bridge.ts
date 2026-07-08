/**
 * Extension event bridge — translates internal client streams into the curated,
 * privacy-safe {@link ExtensionEvent} union extensions consume.
 *
 * This is the SOLE producer of extension events and the enforcement point for
 * the privacy boundary declared in `@dorkos/extension-api`'s `extension-events`
 * module: it reads the raw `SessionEvent` / `SessionListEvent` streams (which DO
 * carry conversation content) and emits only lifecycle/activity summaries,
 * dropping every content-bearing field (message text, tool arguments/results,
 * relay payloads) before an extension sees anything.
 *
 * FSD: a `features/` module translating from `shared/lib` stream primitives — a
 * legal downward dependency. It depends on a minimal {@link ExtensionEventSource}
 * interface (satisfied by the shared `streamManager` singleton) rather than the
 * concrete class, which keeps it unit-testable with a fake source.
 *
 * @module features/extensions/model/extension-event-bridge
 */
import type { SessionEvent, SessionListEvent } from '@dorkos/shared/session-stream';
import type { ExtensionEvent, ExtensionEventKind } from '@dorkos/extension-api';

/**
 * The slice of the shared `StreamManager` the bridge taps. Defined structurally
 * so tests inject a fake and production passes the real singleton.
 */
export interface ExtensionEventSource {
  /** Attached-session events (turn/tool activity), gated to the foreground session. */
  subscribeSessionEvent(handler: (sessionId: string, event: SessionEvent) => void): () => void;
  /** Global session-list events (session started/ended). */
  subscribeListEvent(handler: (event: SessionListEvent) => void): () => void;
  /** Foreground-session attach changes (session switched). */
  subscribeAttachedSessionChange(
    handler: (sessionId: string | null, previousSessionId: string | null) => void
  ): () => void;
  /** Named generic broadcasts from `/api/events` (used for `relay_message`). */
  subscribeEvent(eventName: 'relay_message', handler: (data: unknown) => void): () => void;
}

/** A registered extension subscription: the kinds it wants and its handler. */
interface BridgeSubscription {
  kinds: Set<ExtensionEventKind>;
  handler: (event: ExtensionEvent) => void;
}

/** Per-session, per-turn accumulator for deriving `turn.completed` summaries. */
interface TurnAccumulator {
  startedAt: number;
  toolCallCount: number;
}

/** Minimal shape of a relay envelope the bridge reads (routing metadata only). */
function toRelayNotification(
  data: unknown
): { messageId: string; from: string; subject: string } | null {
  if (typeof data !== 'object' || data === null) return null;
  const env = data as Record<string, unknown>;
  if (
    typeof env.id === 'string' &&
    typeof env.from === 'string' &&
    typeof env.subject === 'string'
  ) {
    // NOTE: env.payload is deliberately NOT read — relay message bodies are
    // conversation content and never cross into an ExtensionEvent.
    return { messageId: env.id, from: env.from, subject: env.subject };
  }
  return null;
}

/**
 * Translates client stream primitives into {@link ExtensionEvent}s and fans them
 * out to per-kind subscribers. One instance is shared across all extensions
 * (constructed once in `main.tsx`); it connects to the source eagerly on
 * construction — the source multiplexes existing connections, so this adds only
 * cheap in-memory listeners.
 */
export class ExtensionEventBridge {
  private readonly subscriptions = new Set<BridgeSubscription>();
  private readonly seenSessions = new Set<string>();
  private readonly turns = new Map<string, TurnAccumulator>();
  private readonly cleanups: Array<() => void> = [];
  /** Injected so tests can control turn-duration timing deterministically. */
  private readonly now: () => number;

  /**
   * @param source - Stream taps (the shared `streamManager` in production).
   * @param options - Optional overrides; `now` seams the clock for tests.
   */
  constructor(source: ExtensionEventSource, options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.connect(source);
  }

  /**
   * Register a handler for a set of event kinds. The caller (the extension API
   * factory) is responsible for capability gating — the bridge trusts the kinds
   * it is handed. Returns an unsubscribe function.
   *
   * @param kinds - Event kinds this subscription should receive.
   * @param handler - Invoked with each matching event.
   */
  subscribe(kinds: ExtensionEventKind[], handler: (event: ExtensionEvent) => void): () => void {
    const sub: BridgeSubscription = { kinds: new Set(kinds), handler };
    this.subscriptions.add(sub);
    return () => {
      this.subscriptions.delete(sub);
    };
  }

  /** Tear down all source subscriptions. Called if the owning tree unmounts. */
  dispose(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    this.subscriptions.clear();
    this.turns.clear();
    this.seenSessions.clear();
  }

  /** Wire the source taps. */
  private connect(source: ExtensionEventSource): void {
    this.cleanups.push(
      source.subscribeSessionEvent((sessionId, event) => this.onSessionEvent(sessionId, event)),
      source.subscribeListEvent((event) => this.onListEvent(event)),
      source.subscribeAttachedSessionChange((sessionId, previousSessionId) =>
        this.emit({ kind: 'session.switched', sessionId, previousSessionId })
      ),
      source.subscribeEvent('relay_message', (data) => {
        const notification = toRelayNotification(data);
        if (notification) this.emit({ kind: 'relay.message', ...notification });
      })
    );
  }

  /** Translate an attached-session event into turn/tool extension events. */
  private onSessionEvent(sessionId: string, event: SessionEvent): void {
    switch (event.type) {
      case 'turn_start':
        this.turns.set(sessionId, { startedAt: this.now(), toolCallCount: 0 });
        this.emit({ kind: 'turn.started', sessionId });
        break;
      case 'tool_call': {
        const turn = this.turns.get(sessionId);
        if (turn) turn.toolCallCount += 1;
        this.emit({
          kind: 'tool.activity',
          sessionId,
          toolName: event.toolName,
          status: 'started',
        });
        break;
      }
      case 'tool_result':
        this.emit({
          kind: 'tool.activity',
          sessionId,
          toolName: event.toolName,
          status: 'completed',
        });
        break;
      case 'turn_end': {
        const turn = this.turns.get(sessionId);
        this.turns.delete(sessionId);
        this.emit({
          kind: 'turn.completed',
          sessionId,
          durationMs: turn ? this.now() - turn.startedAt : null,
          toolCallCount: turn?.toolCallCount ?? 0,
          terminalReason: event.terminalReason,
        });
        break;
      }
      default:
        // Every other session-event type carries conversation content or
        // fidelity detail that is intentionally not exposed to extensions.
        break;
    }
  }

  /** Translate a session-list event into session lifecycle extension events. */
  private onListEvent(event: SessionListEvent): void {
    switch (event.type) {
      case 'session_upserted': {
        const id = event.session.id;
        if (!this.seenSessions.has(id)) {
          this.seenSessions.add(id);
          this.emit({ kind: 'session.started', sessionId: id });
        }
        break;
      }
      case 'session_removed':
        this.seenSessions.delete(event.sessionId);
        this.emit({ kind: 'session.ended', sessionId: event.sessionId });
        break;
      default:
        // `session_status` is per-turn status churn, not a lifecycle boundary.
        break;
    }
  }

  /** Fan an event out to every subscription that requested its kind. */
  private emit(event: ExtensionEvent): void {
    for (const sub of this.subscriptions) {
      if (sub.kinds.has(event.kind)) sub.handler(event);
    }
  }
}

/**
 * Construct the shared bridge from a stream source. Thin factory so `main.tsx`
 * can wire the `streamManager` singleton without importing the class directly.
 *
 * @param source - The stream taps (the shared `streamManager`).
 * @returns A ready {@link ExtensionEventBridge}.
 */
export function createExtensionEventBridge(source: ExtensionEventSource): ExtensionEventBridge {
  return new ExtensionEventBridge(source);
}
