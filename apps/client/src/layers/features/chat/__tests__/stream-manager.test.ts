import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useSessionChatStore } from '@/layers/entities/session';
import { StreamManager } from '../model/stream-manager';
import type { Transport } from '@dorkos/shared/transport';

/** Minimal mock transport — only sendMessage is exercised by StreamManager. */
function createMockTransport(overrides?: Partial<Transport>): Transport {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    // Stubs for the rest of the interface — never called by StreamManager
    listSessions: vi.fn(),
    getSession: vi.fn(),
    updateSession: vi.fn(),
    getMessages: vi.fn(),
    approveTool: vi.fn(),
    denyTool: vi.fn(),
    submitAnswers: vi.fn(),
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    getHealth: vi.fn(),
    deleteSession: vi.fn(),
    getModels: vi.fn(),
    getDefaultCwd: vi.fn(),
    getCommands: vi.fn(),
    getGitStatus: vi.fn(),
    listFiles: vi.fn(),
    getMcpStatus: vi.fn(),
    listSchedules: vi.fn(),
    createSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    listRelayAdapters: vi.fn(),
    getRelayAdapter: vi.fn(),
    createRelayAdapter: vi.fn(),
    updateRelayAdapter: vi.fn(),
    deleteRelayAdapter: vi.fn(),
    getRelayHealth: vi.fn(),
    testRelayAdapter: vi.fn(),
    listRelayConversations: vi.fn(),
    sendMessageRelay: vi.fn(),
    getMessageTrace: vi.fn(),
    listMeshPeers: vi.fn(),
    getMeshMetrics: vi.fn(),
    listAgents: vi.fn(),
    getAgent: vi.fn(),
    scanAgents: vi.fn(),
    registerAgent: vi.fn(),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
    getAgentHealth: vi.fn(),
    triggerScheduleNow: vi.fn(),
    ...overrides,
  } as unknown as Transport;
}

/**
 * Helper: create a transport whose sendMessage blocks until the returned
 * resolve function is called. Avoids never-resolving promises that cause
 * test timeouts.
 */
function createBlockingTransport() {
  let resolve: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const transport = createMockTransport({ sendMessage: vi.fn().mockReturnValue(promise) });
  return { transport, resolve: () => resolve() };
}

/** Yield to microtask queue so the synchronous preamble of an async function executes. */
const tick = () => new Promise<void>((r) => queueMicrotask(r));

describe('StreamManager', () => {
  let manager: StreamManager;

  beforeEach(() => {
    manager = new StreamManager();
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    manager.abortAll();
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Query API
  // ---------------------------------------------------------------------------

  describe('isStreaming', () => {
    it('returns false when no stream is active for the session', () => {
      expect(manager.isStreaming('s1')).toBe(false);
    });

    it('returns true while a stream is in progress', async () => {
      const { transport, resolve } = createBlockingTransport();

      const promise = manager.start({ transport, sessionId: 's1', content: 'hello', cwd: null });
      // All synchronous setup (including streams.set) runs before the first await
      await tick();

      expect(manager.isStreaming('s1')).toBe(true);

      resolve();
      await promise;
      expect(manager.isStreaming('s1')).toBe(false);
    });

    it('returns false after stream completes', async () => {
      const transport = createMockTransport();
      await manager.start({ transport, sessionId: 's1', content: 'hello', cwd: null });
      expect(manager.isStreaming('s1')).toBe(false);
    });
  });

  describe('getActiveSessionIds', () => {
    it('returns empty array when no streams are active', () => {
      expect(manager.getActiveSessionIds()).toEqual([]);
    });

    it('returns all active session IDs', async () => {
      const { transport: t1, resolve: r1 } = createBlockingTransport();
      const { transport: t2, resolve: r2 } = createBlockingTransport();

      const p1 = manager.start({ transport: t1, sessionId: 's1', content: 'a', cwd: null });
      await tick();
      const p2 = manager.start({ transport: t2, sessionId: 's2', content: 'b', cwd: null });
      await tick();

      const ids = manager.getActiveSessionIds();
      expect(ids).toContain('s1');
      expect(ids).toContain('s2');
      expect(ids).toHaveLength(2);

      r1();
      r2();
      await Promise.all([p1, p2]);
    });
  });

  // ---------------------------------------------------------------------------
  // Abort API
  // ---------------------------------------------------------------------------

  describe('abort', () => {
    it('is a no-op for sessions with no active stream', () => {
      manager.abort('nonexistent');
      expect(manager.isStreaming('nonexistent')).toBe(false);
    });

    it('aborts the active stream and sets store status to idle', async () => {
      const { transport, resolve } = createBlockingTransport();

      const promise = manager.start({ transport, sessionId: 's1', content: 'hello', cwd: null });
      await tick();

      expect(manager.isStreaming('s1')).toBe(true);
      manager.abort('s1');
      expect(manager.isStreaming('s1')).toBe(false);

      const session = useSessionChatStore.getState().getSession('s1');
      expect(session.status).toBe('idle');

      resolve();
      await promise;
    });

    it('clears timers when aborting', async () => {
      const { transport, resolve } = createBlockingTransport();

      const promise = manager.start({ transport, sessionId: 's1', content: 'hello', cwd: null });
      await tick();

      // Manually add timers to verify cleanup
      const timers = manager.getOrCreateTimers('s1');
      timers.textStreaming = setTimeout(() => {}, 10_000);
      timers.systemStatus = setTimeout(() => {}, 10_000);

      manager.abort('s1');

      // After abort, getOrCreateTimers returns a fresh object (old was deleted)
      const freshTimers = manager.getOrCreateTimers('s1');
      expect(freshTimers.textStreaming).toBeNull();

      resolve();
      await promise;
    });
  });

  describe('abortAll', () => {
    it('aborts all active streams', async () => {
      const { transport: t1, resolve: r1 } = createBlockingTransport();
      const { transport: t2, resolve: r2 } = createBlockingTransport();

      const p1 = manager.start({ transport: t1, sessionId: 's1', content: 'a', cwd: null });
      await tick();
      const p2 = manager.start({ transport: t2, sessionId: 's2', content: 'b', cwd: null });
      await tick();

      expect(manager.getActiveSessionIds()).toHaveLength(2);

      manager.abortAll();

      expect(manager.getActiveSessionIds()).toHaveLength(0);
      expect(manager.isStreaming('s1')).toBe(false);
      expect(manager.isStreaming('s2')).toBe(false);

      r1();
      r2();
      await Promise.all([p1, p2]);
    });
  });

  // ---------------------------------------------------------------------------
  // start() lifecycle
  // ---------------------------------------------------------------------------

  describe('start', () => {
    it('aborts previous stream when starting a new one for the same session', async () => {
      const { transport: t1, resolve: r1 } = createBlockingTransport();

      const p1 = manager.start({ transport: t1, sessionId: 's1', content: 'first', cwd: null });
      await tick();
      expect(manager.isStreaming('s1')).toBe(true);

      // Start a second stream for same session — should abort the first
      const transport2 = createMockTransport();
      const p2 = manager.start({
        transport: transport2,
        sessionId: 's1',
        content: 'second',
        cwd: null,
      });

      r1();
      await Promise.all([p1, p2]);

      // Both transports should have had sendMessage called
      expect(t1.sendMessage).toHaveBeenCalledTimes(1);
      expect(transport2.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('initializes session in the store', async () => {
      const transport = createMockTransport();
      await manager.start({ transport, sessionId: 'new-session', content: 'hello', cwd: null });

      const state = useSessionChatStore.getState();
      expect(state.sessions['new-session']).toBeDefined();
    });

    it('creates optimistic user message in the store', async () => {
      const { transport, resolve } = createBlockingTransport();

      const promise = manager.start({ transport, sessionId: 's1', content: 'hello', cwd: null });
      await tick();

      const session = useSessionChatStore.getState().getSession('s1');
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0].role).toBe('user');
      expect(session.messages[0].content).toBe('hello');
      expect(session.messages[0]._streaming).toBe(true);

      resolve();
      await promise;
    });

    it('sets streaming status and metadata in the store', async () => {
      const { transport, resolve } = createBlockingTransport();

      const promise = manager.start({ transport, sessionId: 's1', content: 'hello', cwd: null });
      await tick();

      const session = useSessionChatStore.getState().getSession('s1');
      expect(session.status).toBe('streaming');
      expect(session.error).toBeNull();
      expect(session.streamStartTime).toBeGreaterThan(0);
      expect(session.estimatedTokens).toBe(0);

      resolve();
      await promise;
    });

    it('sets status to idle on successful completion', async () => {
      const transport = createMockTransport();
      await manager.start({ transport, sessionId: 's1', content: 'hello', cwd: null });

      const session = useSessionChatStore.getState().getSession('s1');
      expect(session.status).toBe('idle');
    });

    it('applies transformContent before sending', async () => {
      const transport = createMockTransport();

      await manager.start({
        transport,
        sessionId: 's1',
        content: 'raw content',
        cwd: '/test',
        transformContent: (c) => `[transformed] ${c}`,
      });

      expect(transport.sendMessage).toHaveBeenCalledWith(
        's1',
        '[transformed] raw content',
        expect.any(Function),
        expect.any(Object),
        '/test',
        expect.objectContaining({ clientMessageId: expect.stringContaining('pending-user-') })
      );
    });

    it('passes cwd to sendMessage as working directory', async () => {
      const transport = createMockTransport();

      await manager.start({ transport, sessionId: 's1', content: 'hello', cwd: '/my/project' });

      expect(transport.sendMessage).toHaveBeenCalledWith(
        's1',
        'hello',
        expect.any(Function),
        expect.any(Object),
        '/my/project',
        expect.any(Object)
      );
    });

    it('passes undefined cwd when null', async () => {
      const transport = createMockTransport();

      await manager.start({ transport, sessionId: 's1', content: 'hello', cwd: null });

      expect(transport.sendMessage).toHaveBeenCalledWith(
        's1',
        'hello',
        expect.any(Function),
        expect.any(Object),
        undefined,
        expect.any(Object)
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    it('re-throws AbortError so callers can detect user cancellation', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      const transport = createMockTransport({
        sendMessage: vi.fn().mockRejectedValue(abortError),
      });

      // start() re-throws AbortError after setting store to idle
      await expect(
        manager.start({ transport, sessionId: 's1', content: 'hello', cwd: null })
      ).rejects.toMatchObject({ name: 'AbortError' });

      const session = useSessionChatStore.getState().getSession('s1');
      expect(session.status).toBe('idle');
      expect(session.error).toBeNull();
    });

    it('handles SESSION_LOCKED error with auto-dismiss and re-throws for callers', async () => {
      const lockError = Object.assign(new Error('Locked'), { code: 'SESSION_LOCKED' });
      const transport = createMockTransport({
        sendMessage: vi.fn().mockRejectedValue(lockError),
      });

      // start() re-throws after writing busy state to store
      await expect(
        manager.start({ transport, sessionId: 's1', content: 'hello', cwd: null })
      ).rejects.toMatchObject({ code: 'SESSION_LOCKED' });

      const session = useSessionChatStore.getState().getSession('s1');
      expect(session.sessionBusy).toBe(true);
      expect(session.error?.heading).toBe('Session in use');
      // Optimistic user message should be removed
      expect(session.messages.every((m) => !m.id.startsWith('pending-user-'))).toBe(true);

      // Auto-dismiss after timer fires
      await vi.advanceTimersByTimeAsync(6_000);
      const updated = useSessionChatStore.getState().getSession('s1');
      expect(updated.sessionBusy).toBe(false);
      expect(updated.error).toBeNull();
    });

    it('handles non-retryable error, writes to store, and re-throws for callers', async () => {
      const error = Object.assign(new Error('Bad request'), { status: 400 });
      const transport = createMockTransport({
        sendMessage: vi.fn().mockRejectedValue(error),
      });

      // start() re-throws after writing error state to store
      await expect(
        manager.start({ transport, sessionId: 's1', content: 'hello', cwd: null })
      ).rejects.toThrow('Bad request');

      const session = useSessionChatStore.getState().getSession('s1');
      expect(session.status).toBe('error');
      expect(session.error).toBeDefined();
      expect(session.error?.heading).toBe('Error');
      // Optimistic user message should be removed
      expect(session.messages.every((m) => !m.id.startsWith('pending-user-'))).toBe(true);
    });

    it('auto-retries transient errors then succeeds', async () => {
      const networkError = new TypeError('Failed to fetch');
      let callCount = 0;
      const transport = createMockTransport({
        sendMessage: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.reject(networkError);
          return Promise.resolve();
        }),
      });

      const startPromise = manager.start({
        transport,
        sessionId: 's1',
        content: 'hello',
        cwd: null,
      });

      // Advance past the retry delay (POST_RETRY_DELAY_MS = 2000)
      await vi.advanceTimersByTimeAsync(3_000);
      await startPromise;

      expect(transport.sendMessage).toHaveBeenCalledTimes(2);

      const session = useSessionChatStore.getState().getSession('s1');
      expect(session.status).toBe('idle');
      expect(session.error).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // dispatchEvent (Phase 1 stub)
  // ---------------------------------------------------------------------------

  describe('dispatchEvent', () => {
    it('is a no-op when session has no active stream', () => {
      // Should not throw
      manager.dispatchEvent('nonexistent', 'text_delta', { text: 'hello' });
    });

    it('marks assistantCreated on first text_delta', async () => {
      const { transport, resolve } = createBlockingTransport();

      const promise = manager.start({ transport, sessionId: 's1', content: 'hello', cwd: null });
      await tick();

      manager.dispatchEvent('s1', 'text_delta', { text: 'Hi' });

      const session = useSessionChatStore.getState().getSession('s1');
      expect(session.assistantCreated).toBe(true);

      resolve();
      await promise;
    });

    it('marks assistantCreated on first thinking_delta', async () => {
      const { transport, resolve } = createBlockingTransport();

      const promise = manager.start({ transport, sessionId: 's1', content: 'hello', cwd: null });
      await tick();

      manager.dispatchEvent('s1', 'thinking_delta', { text: 'thinking...' });

      const session = useSessionChatStore.getState().getSession('s1');
      expect(session.assistantCreated).toBe(true);

      resolve();
      await promise;
    });

    it('does not re-mark assistantCreated on subsequent events', async () => {
      const { transport, resolve } = createBlockingTransport();

      const promise = manager.start({ transport, sessionId: 's1', content: 'hello', cwd: null });
      await tick();

      manager.dispatchEvent('s1', 'text_delta', { text: 'First' });
      manager.dispatchEvent('s1', 'text_delta', { text: ' Second' });

      const session = useSessionChatStore.getState().getSession('s1');
      expect(session.assistantCreated).toBe(true);

      resolve();
      await promise;
    });
  });

  // ---------------------------------------------------------------------------
  // Timer management
  // ---------------------------------------------------------------------------

  describe('timer management', () => {
    it('getOrCreateTimers creates default timers for new session', () => {
      const timers = manager.getOrCreateTimers('s1');
      expect(timers.textStreaming).toBeNull();
      expect(timers.systemStatus).toBeNull();
      expect(timers.sessionBusy).toBeNull();
      expect(timers.presencePulse).toBeNull();
      expect(timers.rateLimitClear).toBeNull();
    });

    it('getOrCreateTimers returns same object on repeated calls', () => {
      const first = manager.getOrCreateTimers('s1');
      const second = manager.getOrCreateTimers('s1');
      expect(first).toBe(second);
    });

    it('clearTimers removes all active timers', () => {
      const timers = manager.getOrCreateTimers('s1');
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

      timers.textStreaming = setTimeout(() => {}, 10_000);
      timers.systemStatus = setTimeout(() => {}, 10_000);
      timers.sessionBusy = setTimeout(() => {}, 10_000);
      timers.presencePulse = setTimeout(() => {}, 10_000);
      timers.rateLimitClear = setTimeout(() => {}, 10_000);

      manager.clearTimers('s1');

      expect(clearSpy).toHaveBeenCalledTimes(5);
      clearSpy.mockRestore();
    });

    it('clearTimers is a no-op for sessions without timers', () => {
      manager.clearTimers('nonexistent');
    });
  });
});
