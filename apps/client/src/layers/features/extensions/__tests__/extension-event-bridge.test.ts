import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionEvent, SessionListEvent } from '@dorkos/shared/session-stream';
import type { ExtensionEvent } from '@dorkos/extension-api';
import { ExtensionEventBridge, type ExtensionEventSource } from '../model/extension-event-bridge';

/**
 * A controllable fake of the StreamManager taps the bridge consumes. Each
 * `emit*` method drives the corresponding source callback so a test can push
 * frames synchronously — the same fake-connection pattern the StreamManager
 * tests use.
 */
class FakeSource implements ExtensionEventSource {
  private sessionHandlers: Array<(sessionId: string, event: SessionEvent) => void> = [];
  private listHandlers: Array<(event: SessionListEvent) => void> = [];
  private attachHandlers: Array<(sessionId: string | null, previous: string | null) => void> = [];
  private relayHandlers: Array<(data: unknown) => void> = [];

  subscribeSessionEvent(handler: (sessionId: string, event: SessionEvent) => void): () => void {
    this.sessionHandlers.push(handler);
    return () => {
      this.sessionHandlers = this.sessionHandlers.filter((h) => h !== handler);
    };
  }

  subscribeListEvent(handler: (event: SessionListEvent) => void): () => void {
    this.listHandlers.push(handler);
    return () => {
      this.listHandlers = this.listHandlers.filter((h) => h !== handler);
    };
  }

  subscribeAttachedSessionChange(
    handler: (sessionId: string | null, previous: string | null) => void
  ): () => void {
    this.attachHandlers.push(handler);
    return () => {
      this.attachHandlers = this.attachHandlers.filter((h) => h !== handler);
    };
  }

  subscribeEvent(_eventName: 'relay_message', handler: (data: unknown) => void): () => void {
    this.relayHandlers.push(handler);
    return () => {
      this.relayHandlers = this.relayHandlers.filter((h) => h !== handler);
    };
  }

  emitSessionEvent(sessionId: string, event: SessionEvent): void {
    for (const h of this.sessionHandlers) h(sessionId, event);
  }
  emitListEvent(event: SessionListEvent): void {
    for (const h of this.listHandlers) h(event);
  }
  emitAttachChange(sessionId: string | null, previous: string | null): void {
    for (const h of this.attachHandlers) h(sessionId, previous);
  }
  emitRelay(data: unknown): void {
    for (const h of this.relayHandlers) h(data);
  }

  /** Number of live source subscriptions — used to assert cleanup. */
  activeSubscriptions(): number {
    return (
      this.sessionHandlers.length +
      this.listHandlers.length +
      this.attachHandlers.length +
      this.relayHandlers.length
    );
  }
}

// Minimal SessionEvent factory — carries only the fields the bridge reads.
function sessionEvent(
  partial: Partial<SessionEvent> & { type: SessionEvent['type'] }
): SessionEvent {
  return { seq: 0, ...partial } as SessionEvent;
}

describe('ExtensionEventBridge', () => {
  let source: FakeSource;
  let bridge: ExtensionEventBridge;
  let received: ExtensionEvent[];
  let now: number;

  beforeEach(() => {
    source = new FakeSource();
    now = 1000;
    bridge = new ExtensionEventBridge(source, { now: () => now });
    received = [];
  });

  function subscribeAll() {
    return bridge.subscribe(
      [
        'session.started',
        'session.ended',
        'session.switched',
        'turn.started',
        'turn.completed',
        'tool.activity',
        'relay.message',
      ],
      (event) => received.push(event)
    );
  }

  describe('turn lifecycle', () => {
    it('translates turn_start into turn.started', () => {
      subscribeAll();
      source.emitSessionEvent('s1', sessionEvent({ type: 'turn_start' }));
      expect(received).toEqual([{ kind: 'turn.started', sessionId: 's1' }]);
    });

    it('summarizes turn.completed with duration and tool-call count', () => {
      subscribeAll();
      source.emitSessionEvent('s1', sessionEvent({ type: 'turn_start' }));
      source.emitSessionEvent(
        's1',
        sessionEvent({ type: 'tool_call', toolCallId: 't1', toolName: 'Bash', status: 'complete' })
      );
      source.emitSessionEvent(
        's1',
        sessionEvent({ type: 'tool_call', toolCallId: 't2', toolName: 'Read', status: 'complete' })
      );
      now = 3500; // 2500ms after turn_start
      source.emitSessionEvent(
        's1',
        sessionEvent({ type: 'turn_end', terminalReason: 'completed' })
      );

      const completed = received.find((e) => e.kind === 'turn.completed');
      expect(completed).toEqual({
        kind: 'turn.completed',
        sessionId: 's1',
        durationMs: 2500,
        toolCallCount: 2,
        terminalReason: 'completed',
      });
    });

    it('reports null duration when the turn start was not observed', () => {
      subscribeAll();
      source.emitSessionEvent('s1', sessionEvent({ type: 'turn_end' }));
      const completed = received.find((e) => e.kind === 'turn.completed');
      expect(completed).toMatchObject({ durationMs: null, toolCallCount: 0 });
    });
  });

  describe('tool activity', () => {
    it('emits started on tool_call and completed on tool_result with only the name', () => {
      subscribeAll();
      source.emitSessionEvent(
        's1',
        sessionEvent({ type: 'tool_call', toolCallId: 't1', toolName: 'Bash', status: 'running' })
      );
      source.emitSessionEvent(
        's1',
        sessionEvent({
          type: 'tool_result',
          toolCallId: 't1',
          toolName: 'Bash',
          status: 'complete',
          result: 'SECRET OUTPUT',
        })
      );

      const toolEvents = received.filter((e) => e.kind === 'tool.activity');
      expect(toolEvents).toEqual([
        { kind: 'tool.activity', sessionId: 's1', toolName: 'Bash', status: 'started' },
        { kind: 'tool.activity', sessionId: 's1', toolName: 'Bash', status: 'completed' },
      ]);
      // Privacy: no event carries the tool result content.
      expect(JSON.stringify(received)).not.toContain('SECRET OUTPUT');
    });
  });

  describe('content exclusion (privacy boundary)', () => {
    it('does not emit anything for text_delta or thinking_delta', () => {
      subscribeAll();
      source.emitSessionEvent('s1', sessionEvent({ type: 'text_delta', text: 'hello world' }));
      source.emitSessionEvent('s1', sessionEvent({ type: 'thinking_delta', text: 'reasoning' }));
      expect(received).toEqual([]);
    });
  });

  describe('session lifecycle', () => {
    it('emits session.started only the first time a session is upserted', () => {
      subscribeAll();
      const upsert = {
        type: 'session_upserted',
        session: { id: 's1' },
      } as unknown as SessionListEvent;
      source.emitListEvent(upsert);
      source.emitListEvent(upsert);
      const started = received.filter((e) => e.kind === 'session.started');
      expect(started).toEqual([{ kind: 'session.started', sessionId: 's1' }]);
    });

    it('emits session.ended on session_removed and re-arms started', () => {
      subscribeAll();
      const upsert = {
        type: 'session_upserted',
        session: { id: 's1' },
      } as unknown as SessionListEvent;
      source.emitListEvent(upsert);
      source.emitListEvent({ type: 'session_removed', sessionId: 's1' });
      source.emitListEvent(upsert); // seen-set cleared → started fires again

      expect(received.filter((e) => e.kind === 'session.started')).toHaveLength(2);
      expect(received.filter((e) => e.kind === 'session.ended')).toEqual([
        { kind: 'session.ended', sessionId: 's1' },
      ]);
    });

    it('ignores session_status churn', () => {
      subscribeAll();
      source.emitListEvent({
        type: 'session_status',
        sessionId: 's1',
        status: {},
      } as unknown as SessionListEvent);
      expect(received).toEqual([]);
    });

    it('emits session.switched from attach changes', () => {
      subscribeAll();
      source.emitAttachChange('s2', 's1');
      expect(received).toEqual([
        { kind: 'session.switched', sessionId: 's2', previousSessionId: 's1' },
      ]);
    });
  });

  describe('relay notifications', () => {
    it('emits routing metadata only and never the payload', () => {
      subscribeAll();
      source.emitRelay({
        id: 'msg-1',
        from: 'agent://kai',
        subject: 'relay.human.console.dm',
        payload: { body: 'CONFIDENTIAL' },
      });
      const relay = received.find((e) => e.kind === 'relay.message');
      expect(relay).toEqual({
        kind: 'relay.message',
        messageId: 'msg-1',
        from: 'agent://kai',
        subject: 'relay.human.console.dm',
      });
      expect(JSON.stringify(received)).not.toContain('CONFIDENTIAL');
    });

    it('drops malformed relay envelopes', () => {
      subscribeAll();
      source.emitRelay({ id: 42 });
      source.emitRelay(null);
      source.emitRelay('not an object');
      expect(received).toEqual([]);
    });
  });

  describe('subscription filtering and cleanup', () => {
    it('only delivers the kinds a subscription asked for', () => {
      bridge.subscribe(['turn.started'], (event) => received.push(event));
      source.emitSessionEvent('s1', sessionEvent({ type: 'turn_start' }));
      source.emitSessionEvent(
        's1',
        sessionEvent({ type: 'tool_call', toolCallId: 't1', toolName: 'Bash', status: 'running' })
      );
      expect(received).toEqual([{ kind: 'turn.started', sessionId: 's1' }]);
    });

    it('stops delivering after unsubscribe', () => {
      const unsub = subscribeAll();
      source.emitSessionEvent('s1', sessionEvent({ type: 'turn_start' }));
      unsub();
      source.emitSessionEvent('s1', sessionEvent({ type: 'turn_start' }));
      expect(received).toHaveLength(1);
    });

    it('fans one event out to multiple subscribers', () => {
      const a: ExtensionEvent[] = [];
      const b: ExtensionEvent[] = [];
      bridge.subscribe(['turn.started'], (e) => a.push(e));
      bridge.subscribe(['turn.started'], (e) => b.push(e));
      source.emitSessionEvent('s1', sessionEvent({ type: 'turn_start' }));
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it('dispose() tears down every source subscription', () => {
      expect(source.activeSubscriptions()).toBeGreaterThan(0);
      bridge.dispose();
      expect(source.activeSubscriptions()).toBe(0);
    });
  });
});
