import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Response } from 'express';
import type { TranscriptReader } from '../transcript-reader.js';

vi.mock('../../lib/logger.js', () => ({
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
  let SessionBroadcaster: typeof import('../session-broadcaster.js').SessionBroadcaster;
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
    const module = await import('../session-broadcaster.js');
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
    it('adds client to set and sends sync_connected', () => {
      const sessionId = 'session-123';
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes);

      expect(mockRes.write).toHaveBeenCalledWith(
        `event: sync_connected\ndata: ${JSON.stringify({ sessionId })}\n\n`
      );
      expect(mockRes.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('starts watcher on first client registration', () => {
      const sessionId = 'session-123';
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes);

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
      const mockRes2 = { ...mockRes } as unknown as Response;
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes);
      broadcaster.registerClient(sessionId, '/vault', mockRes2);

      expect(mockChokidar.watch).toHaveBeenCalledTimes(1);
    });

    it('auto-deregisters on response close', () => {
      const sessionId = 'session-123';
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes);
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

      broadcaster.registerClient(sessionId, '/vault', mockRes);

      // Wait for async initialization
      await new Promise(process.nextTick);

      expect(mockTranscriptReader.readFromOffset).toHaveBeenCalledWith('/vault', sessionId, 0);
    });

    it('handles file not existing yet (offset starts at 0)', async () => {
      const sessionId = 'session-new';
      vi.mocked(mockTranscriptReader.readFromOffset).mockRejectedValue(new Error('ENOENT'));

      broadcaster.registerClient(sessionId, '/vault', mockRes);

      // Wait for async initialization
      await new Promise(process.nextTick);

      // Should not throw, offset defaults to 0
      expect(mockRes.write).toHaveBeenCalled();
    });
  });

  describe('deregisterClient', () => {
    it('removes client from set', () => {
      const sessionId = 'session-123';
      vi.mocked(mockTranscriptReader.readFromOffset).mockResolvedValue({
        content: '',
        newOffset: 100,
      });

      broadcaster.registerClient(sessionId, '/vault', mockRes);
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

      broadcaster.registerClient(sessionId, '/vault', mockRes);
      broadcaster.registerClient(sessionId, '/vault', mockRes2);

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

      broadcaster.registerClient(sessionId, '/vault', mockRes);

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

      broadcaster.registerClient(sessionId, '/vault', mockRes);
      broadcaster.registerClient(sessionId, '/vault', mockRes2);

      // Wait for initialization to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Clear previous write calls (sync_connected)
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

      broadcaster.registerClient(sessionId, '/vault', mockRes);
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

      broadcaster.registerClient(sessionId, '/vault', mockRes);
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
      const { logger } = await import('../../lib/logger.js');

      vi.mocked(mockTranscriptReader.readFromOffset)
        .mockResolvedValueOnce({ content: '', newOffset: 100 })
        .mockResolvedValueOnce({ content: 'data\n', newOffset: 150 });

      broadcaster.registerClient(sessionId, '/vault', mockRes);
      await new Promise(process.nextTick);

      // Now mock write to throw on the UPDATE (not sync_connected)
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

      broadcaster.registerClient(sessionId, '/vault', mockRes);
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

      broadcaster.registerClient(sessionId1, '/vault', mockRes);
      broadcaster.registerClient(sessionId2, '/vault', mockRes2);

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

      broadcaster.registerClient(sessionId, '/vault', mockRes);

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

      broadcaster.registerClient(sessionId, '/vault', mockRes);

      // Should not throw
      expect(() => broadcaster.shutdown()).not.toThrow();
    });
  });
});
