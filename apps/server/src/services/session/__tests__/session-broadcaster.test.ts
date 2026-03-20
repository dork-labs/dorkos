import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Response } from 'express';
import type { TranscriptReader } from '../../runtimes/claude-code/transcript-reader.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
  initLogger: vi.fn(),
}));

// Mock chokidar before importing SessionBroadcaster
const mockWatcher = {
  on: vi.fn(),
  close: vi.fn(),
};
const mockChokidar = {
  watch: vi.fn(() => mockWatcher),
};
vi.mock('chokidar', () => ({ default: mockChokidar }));

describe('SessionBroadcaster', () => {
  let SessionBroadcaster: typeof import('../../runtimes/claude-code/session-broadcaster.js').SessionBroadcaster;
  let broadcaster: InstanceType<typeof SessionBroadcaster>;
  let mockTranscriptReader: TranscriptReader;
  let mockRes: Response;
  let closeHandler: (() => void) | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    closeHandler = null;

    // Reset watcher mock
    mockWatcher.on.mockReturnValue(mockWatcher);
    mockWatcher.close.mockReturnValue(undefined);
    mockChokidar.watch.mockReturnValue(mockWatcher);

    // Import module after mocks are set up
    const module = await import('../../runtimes/claude-code/session-broadcaster.js');
    SessionBroadcaster = module.SessionBroadcaster;

    // Mock TranscriptReader
    mockTranscriptReader = {
      getTranscriptsDir: vi.fn(() => '/home/.claude/projects/test-vault'),
      readFromOffset: vi.fn(),
    } as unknown as TranscriptReader;

    // Mock Response
    mockRes = {
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn((event, cb) => {
        if (event === 'close') closeHandler = cb;
      }),
      headersSent: true,
    } as unknown as Response;

    broadcaster = new SessionBroadcaster(mockTranscriptReader);
  });

  afterEach(() => {
    broadcaster.shutdown();
  });

  describe('registerClient', () => {
    it('adds client to map and sends sync_connected then presence_update', () => {
      const sessionId = 'session-123';
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc');

      expect(mockRes.write).toHaveBeenCalledWith(
        `event: sync_connected\ndata: ${JSON.stringify({ sessionId })}\n\n`
      );
      expect(mockRes.write).toHaveBeenCalledWith(expect.stringContaining('presence_update'));
      expect(mockRes.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('starts watcher on first client registration', () => {
      const sessionId = 'session-123';
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc');

      expect(mockChokidar.watch).toHaveBeenCalledWith(
        '/home/.claude/projects/test-vault/session-123.jsonl',
        expect.objectContaining({
          persistent: true,
          ignoreInitial: true,
        })
      );
      expect(mockWatcher.on).toHaveBeenCalledWith('change', expect.any(Function));
    });

    it('does not start duplicate watcher for same session', () => {
      const sessionId = 'session-123';
      const mockRes2 = {
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
        headersSent: true,
      } as unknown as Response;
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc');
      broadcaster.registerClient(sessionId, '/vault', mockRes2, 'web-def');

      expect(mockChokidar.watch).toHaveBeenCalledTimes(1);
    });

    it('auto-deregisters on response close', () => {
      const sessionId = 'session-123';
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc');
      expect(closeHandler).not.toBeNull();

      // Simulate close event
      closeHandler!();

      // Watcher should be closed since no clients remain
      expect(mockWatcher.close).toHaveBeenCalled();
    });

    it('initializes offset to current file size', async () => {
      const sessionId = 'session-456';
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: 'existing content',
        newOffset: 500,
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc');

      // Wait for async initialization
      await new Promise(process.nextTick);

      expect(mockTranscriptReader.readFromOffset).toHaveBeenCalledWith('/vault', sessionId, 0);
    });

    it('handles file not existing yet (offset starts at 0)', async () => {
      const sessionId = 'session-new';
      vi.mocked(mockTranscriptReader.readFromOffset).mockRejectedValue(new Error('ENOENT'));

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc');

      // Wait for async initialization
      await new Promise(process.nextTick);

      // Should not throw, offset defaults to 0
      expect(mockRes.write).toHaveBeenCalled();
    });
  });

  describe('deregisterClient', () => {
    it('removes client from map', () => {
      const sessionId = 'session-123';
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc');
      broadcaster.deregisterClient(sessionId, mockRes);

      // Watcher should be closed
      expect(mockWatcher.close).toHaveBeenCalled();
    });

    it('stops watcher when last client disconnects', () => {
      const sessionId = 'session-123';
      const mockRes2 = {
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
        headersSent: true,
      } as unknown as Response;

      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc');
      broadcaster.registerClient(sessionId, '/vault', mockRes2, 'web-def');

      // Deregister first client
      broadcaster.deregisterClient(sessionId, mockRes);
      expect(mockWatcher.close).not.toHaveBeenCalled();

      // Deregister second client
      broadcaster.deregisterClient(sessionId, mockRes2);
      expect(mockWatcher.close).toHaveBeenCalled();
    });

    it('does nothing if session not found', () => {
      broadcaster.deregisterClient('nonexistent', mockRes);
      expect(mockWatcher.close).not.toHaveBeenCalled();
    });

    it('clears debounce timer on last client disconnect', () => {
      vi.useFakeTimers();
      const sessionId = 'session-123';
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc');

      // Trigger file change to create debounce timer
      const changeHandler = mockWatcher.on.mock.calls.find(([event]) => event === 'change')?.[1] as
        | (() => void)
        | undefined;
      expect(changeHandler).toBeDefined();
      changeHandler!();

      // Deregister before timer fires
      broadcaster.deregisterClient(sessionId, mockRes);

      // Timer should not fire
      vi.runAllTimers();

      vi.useRealTimers();
    });
  });

  describe('broadcastUpdate', () => {
    it('sends sync_update to all connected clients', async () => {
      const sessionId = 'session-123';
      const mockRes2 = {
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
        headersSent: true,
      } as unknown as Response;

      // Mock readFromOffset to handle initialization (offset 0) and update (offset 100)
      vi.mocked(mockTranscriptReader.readFromOffset).mockImplementation(
        async (_vaultRoot: string, _sessionId: string, fromOffset: number) => {
          if (fromOffset === 0) {
            // Initialization: file size is 100
            return { content: '', newOffset: 100 };
          } else if (fromOffset === 100) {
            // Update: new content added
            return { content: '{"type":"user"}\n', newOffset: 200 };
          }
          return { content: '', newOffset: fromOffset };
        }
      );

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc');
      broadcaster.registerClient(sessionId, '/vault', mockRes2, 'web-def');

      // Wait for initialization to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Clear previous write calls (sync_connected + presence_update)
      vi.mocked(mockRes.write).mockClear();
      vi.mocked(mockRes2.write).mockClear();

      // Trigger file change
      const changeHandler = mockWatcher.on.mock.calls.find(([event]) => event === 'change')?.[1] as
        | (() => void)
        | undefined;
      expect(changeHandler).toBeDefined();
      changeHandler!();

      // Wait for debounce (100ms) + async operations
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Both clients should receive update
      expect(mockRes.write).toHaveBeenCalledWith(expect.stringContaining('event: sync_update'));
      expect(mockRes2.write).toHaveBeenCalledWith(expect.stringContaining('event: sync_update'));

      const eventData = JSON.parse(
        vi
          .mocked(mockRes.write)
          .mock.calls[0][0].toString()
          .replace('event: sync_update\ndata: ', '')
          .replace('\n\n', '')
      );
      expect(eventData).toMatchObject({
        sessionId,
        timestamp: expect.any(String),
      });
    });

    it('does not broadcast if no new content', async () => {
      vi.useFakeTimers();
      const sessionId = 'session-123';

      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc');
      await vi.runOnlyPendingTimersAsync();

      vi.mocked(mockRes.write).mockClear();

      // Trigger change with no new content
      const changeHandler = mockWatcher.on.mock.calls.find(([event]) => event === 'change')?.[1] as
        | (() => void)
        | undefined;
      changeHandler!();

      await vi.runOnlyPendingTimersAsync();

      // Should only have sync_connected, not sync_update
      expect(mockRes.write).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('updates offset after broadcasting', async () => {
      vi.useFakeTimers();
      const sessionId = 'session-123';

      // Initial: offset 100
      vi.mocked(mockTranscriptReader.readFromOffset)
        .mockResolvedValueOnce({ content: '', newOffset: 100 })
        .mockResolvedValueOnce({ content: 'new\n', newOffset: 200 })
        .mockResolvedValueOnce({ content: '', newOffset: 200 });

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc');
      await vi.runOnlyPendingTimersAsync();

      // Trigger change
      const changeHandler = mockWatcher.on.mock.calls.find(([event]) => event === 'change')?.[1] as
        | (() => void)
        | undefined;
      changeHandler!();

      await vi.runOnlyPendingTimersAsync();

      // Next read should use offset 200
      changeHandler!();
      await vi.runOnlyPendingTimersAsync();

      expect(mockTranscriptReader.readFromOffset).toHaveBeenLastCalledWith(
        '/vault',
        sessionId,
        200
      );

      vi.useRealTimers();
    });

    it('handles client write errors gracefully', async () => {
      const sessionId = 'session-123';
      const { logger } = await import('../../../lib/logger.js');

      vi.mocked(mockTranscriptReader.readFromOffset)
        .mockResolvedValueOnce({ content: '', newOffset: 100 })
        .mockResolvedValueOnce({ content: 'data\n', newOffset: 150 });

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc');
      await new Promise(process.nextTick);

      // Now mock write to throw on the UPDATE (not sync_connected or presence)
      vi.mocked(mockRes.write).mockImplementationOnce(() => {
        throw new Error('Connection reset');
      });

      const changeHandler = mockWatcher.on.mock.calls.find(([event]) => event === 'change')?.[1] as
        | (() => void)
        | undefined;
      changeHandler!();

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should log error but not throw
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to write to client'),
        expect.any(Error)
      );
    });
  });

  describe('debouncing', () => {
    it('batches rapid file changes', async () => {
      vi.useFakeTimers();
      const sessionId = 'session-123';

      vi.mocked(mockTranscriptReader.readFromOffset)
        .mockResolvedValueOnce({ content: '', newOffset: 100 })
        .mockResolvedValue({ content: 'data\n', newOffset: 200 });

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc');
      await vi.runOnlyPendingTimersAsync();

      vi.mocked(mockRes.write).mockClear();

      const changeHandler = mockWatcher.on.mock.calls.find(([event]) => event === 'change')?.[1] as
        | (() => void)
        | undefined;

      // Trigger multiple rapid changes
      changeHandler!();
      changeHandler!();
      changeHandler!();

      // Advance just before debounce expires
      vi.advanceTimersByTime(50);

      // Trigger another change — should reset timer
      changeHandler!();

      // Advance past original debounce time (100ms from first call)
      vi.advanceTimersByTime(60);

      // Should not have broadcasted yet (timer was reset)
      expect(mockRes.write).not.toHaveBeenCalled();

      // Advance to complete debounce
      vi.advanceTimersByTime(50);

      await vi.runOnlyPendingTimersAsync();

      // Should broadcast only once
      expect(mockRes.write).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });

  describe('broadcastUpdate backpressure', () => {
    it('waits for drain on sync_update writes', async () => {
      const onceCallbacks: Array<[string, () => void]> = [];
      const bpRes = {
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn((event: string, cb: () => void) => {
          if (event === 'close') closeHandler = cb;
        }),
        once: vi.fn((event: string, cb: () => void) => {
          onceCallbacks.push([event, cb]);
        }),
        headersSent: true,
      } as unknown as Response;

      // sync_connected returns true, presence_update returns true, sync_update returns false
      vi.mocked(bpRes.write)
        .mockReturnValueOnce(true) // sync_connected
        .mockReturnValueOnce(true) // presence_update
        .mockReturnValueOnce(false) // sync_update triggers backpressure
        .mockReturnValue(true);

      vi.mocked(mockTranscriptReader.readFromOffset)
        .mockResolvedValueOnce({ content: '', newOffset: 100 }) // init
        .mockResolvedValueOnce({ content: 'new data\n', newOffset: 200 }); // update

      broadcaster.registerClient('session-1', '/vault', bpRes, 'web-bp');

      // Wait for offset init
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Trigger file change
      const changeHandler = mockWatcher.on.mock.calls.find(([event]) => event === 'change')?.[1] as
        | (() => void)
        | undefined;
      expect(changeHandler).toBeDefined();
      changeHandler!();

      // Wait for debounce + async
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should have registered a drain listener
      const drainCall = onceCallbacks.find(([event]) => event === 'drain');
      expect(drainCall).toBeDefined();
    });
  });

  describe('shutdown', () => {
    it('closes all watchers and clients', () => {
      const sessionId1 = 'session-1';
      const sessionId2 = 'session-2';
      const mockRes2 = {
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
        headersSent: true,
      } as unknown as Response;

      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      broadcaster.registerClient(sessionId1, '/vault', mockRes, 'web-abc');
      broadcaster.registerClient(sessionId2, '/vault', mockRes2, 'web-def');

      broadcaster.shutdown();

      expect(mockWatcher.close).toHaveBeenCalledTimes(2);
      expect(mockRes.end).toHaveBeenCalled();
      expect(mockRes2.end).toHaveBeenCalled();
    });

    it('clears all debounce timers', () => {
      vi.useFakeTimers();
      const sessionId = 'session-123';

      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc');

      const changeHandler = mockWatcher.on.mock.calls.find(([event]) => event === 'change')?.[1] as
        | (() => void)
        | undefined;
      changeHandler!();

      // Shutdown before timer fires
      broadcaster.shutdown();

      // Timer should not fire
      vi.runAllTimers();

      vi.useRealTimers();
    });

    it('ignores errors when ending clients', () => {
      const sessionId = 'session-123';
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      vi.mocked(mockRes.end).mockImplementation(() => {
        throw new Error('Already closed');
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc');

      // Should not throw
      expect(() => broadcaster.shutdown()).not.toThrow();
    });
  });

  describe('presence broadcasts', () => {
    it('broadcasts presence_update on client registration', () => {
      const sessionId = 'session-123';
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc123');

      // Should have written sync_connected AND presence_update
      expect(mockRes.write).toHaveBeenCalledTimes(2);
      expect(mockRes.write).toHaveBeenNthCalledWith(1, expect.stringContaining('sync_connected'));
      expect(mockRes.write).toHaveBeenNthCalledWith(2, expect.stringContaining('presence_update'));

      // Parse the presence event
      const presenceCall = vi.mocked(mockRes.write).mock.calls[1][0].toString();
      const data = JSON.parse(
        presenceCall.replace('event: presence_update\ndata: ', '').replace('\n\n', '')
      );
      expect(data.clientCount).toBe(1);
      expect(data.clients).toHaveLength(1);
      expect(data.clients[0].type).toBe('web');
      expect(data.lockInfo).toBeNull();
    });

    it('broadcasts updated count when second client connects', () => {
      const sessionId = 'session-123';
      const mockRes2 = {
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
        headersSent: true,
      } as unknown as Response;
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc');
      broadcaster.registerClient(sessionId, '/vault', mockRes2, 'obsidian-xyz');

      // Second registration should trigger presence broadcast to both clients
      // mockRes gets: sync_connected, presence(1), presence(2)
      // mockRes2 gets: sync_connected, presence(2)
      const lastPresenceCall = vi.mocked(mockRes.write).mock.calls.at(-1)?.[0].toString() ?? '';
      const data = JSON.parse(
        lastPresenceCall.replace('event: presence_update\ndata: ', '').replace('\n\n', '')
      );
      expect(data.clientCount).toBe(2);
      expect(data.clients).toHaveLength(2);
    });

    it('broadcasts presence_update on client disconnect', () => {
      const sessionId = 'session-123';
      const mockRes2 = {
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
        headersSent: true,
      } as unknown as Response;
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes, 'web-abc');
      broadcaster.registerClient(sessionId, '/vault', mockRes2, 'obsidian-xyz');

      // Clear mocks, then disconnect first client
      vi.mocked(mockRes2.write).mockClear();
      broadcaster.deregisterClient(sessionId, mockRes);

      // Remaining client should get updated presence
      expect(mockRes2.write).toHaveBeenCalledWith(expect.stringContaining('presence_update'));
      const presenceCall = vi.mocked(mockRes2.write).mock.calls[0][0].toString();
      const data = JSON.parse(
        presenceCall.replace('event: presence_update\ndata: ', '').replace('\n\n', '')
      );
      expect(data.clientCount).toBe(1);
    });
  });

  describe('inferClientType', () => {
    it('infers web type from web- prefix', () => {
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });
      broadcaster.registerClient('s1', '/vault', mockRes, 'web-abc');
      const info = broadcaster.getPresenceInfo('s1');
      expect(info?.clients[0].type).toBe('web');
    });

    it('infers obsidian type from obsidian- prefix', () => {
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });
      broadcaster.registerClient('s1', '/vault', mockRes, 'obsidian-xyz');
      const info = broadcaster.getPresenceInfo('s1');
      expect(info?.clients[0].type).toBe('obsidian');
    });

    it('infers mcp type from mcp- prefix', () => {
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });
      broadcaster.registerClient('s1', '/vault', mockRes, 'mcp-external');
      const info = broadcaster.getPresenceInfo('s1');
      expect(info?.clients[0].type).toBe('mcp');
    });

    it('defaults to unknown for unrecognized prefix', () => {
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });
      broadcaster.registerClient('s1', '/vault', mockRes, 'cb-1234-abc');
      const info = broadcaster.getPresenceInfo('s1');
      expect(info?.clients[0].type).toBe('unknown');
    });
  });

  describe('getPresenceInfo', () => {
    it('returns null for unknown session', () => {
      expect(broadcaster.getPresenceInfo('nonexistent')).toBeNull();
    });

    it('returns client metadata for active session', () => {
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });
      broadcaster.registerClient('s1', '/vault', mockRes, 'web-abc');
      const info = broadcaster.getPresenceInfo('s1');
      expect(info).toMatchObject({
        clientCount: 1,
        clients: [{ type: 'web', connectedAt: expect.any(String) }],
        lockInfo: null,
      });
    });
  });
});
