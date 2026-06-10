import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Session } from '@dorkos/shared/types';
import type { SessionListEvent } from '@dorkos/shared/session-stream';
import type { TranscriptReader } from '../sessions/transcript-reader.js';

vi.mock('../../../../lib/logger.js', () => ({
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

// Mock chokidar so we can drive add/change/unlink handlers synchronously.
// Hoisted so the objects exist when the (also-hoisted) vi.mock factory runs.
const { mockWatcher, mockChokidar } = vi.hoisted(() => {
  const watcher = { on: vi.fn(), close: vi.fn() };
  return { mockWatcher: watcher, mockChokidar: { watch: vi.fn(() => watcher) } };
});
vi.mock('chokidar', () => ({ default: mockChokidar }));

import { watchSessionList } from '../sessions/session-list-watcher.js';

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: `Session ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    permissionMode: 'default',
    ...overrides,
  };
}

/** Resolve the watcher's handler for a chokidar event name. */
function handlerFor(event: 'add' | 'change' | 'unlink'): () => void {
  const call = mockWatcher.on.mock.calls.find(([e]) => e === event);
  if (!call) throw new Error(`no ${event} handler registered`);
  return call[1] as () => void;
}

describe('watchSessionList', () => {
  let reader: Pick<TranscriptReader, 'getTranscriptsDir' | 'listSessions'>;
  let listSessions: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockWatcher.on.mockReturnValue(mockWatcher);
    mockWatcher.close.mockResolvedValue(undefined);
    mockChokidar.watch.mockReturnValue(mockWatcher);
    listSessions = vi.fn();
    reader = {
      getTranscriptsDir: vi.fn(() => '/home/.claude/projects/-repo'),
      listSessions,
    };
  });

  // The initial on-disk inventory is emitted as one session_upserted per session.
  it('emits session_upserted for every session already on disk', async () => {
    listSessions.mockResolvedValueOnce([makeSession('s1'), makeSession('s2')]);

    const it = watchSessionList(reader as TranscriptReader, '/repo')[Symbol.asyncIterator]();
    const first = await it.next();
    const second = await it.next();

    expect(first.value).toEqual({ type: 'session_upserted', session: makeSession('s1') });
    expect(second.value).toEqual({ type: 'session_upserted', session: makeSession('s2') });
    await it.return?.();
  });

  // An EXTERNAL JSONL write (Claude Code CLI) surfaces as session_upserted, debounced.
  it('emits session_upserted for an externally-created session via the debounced watch', async () => {
    listSessions.mockResolvedValueOnce([]); // empty initial inventory
    const it = watchSessionList(reader as TranscriptReader, '/repo')[Symbol.asyncIterator]();

    // Begin awaiting the next event before the external write lands.
    const nextPromise = it.next();

    // Simulate Claude Code CLI creating a new transcript file outside DorkOS:
    // the next listSessions reflects the new file.
    listSessions.mockResolvedValueOnce([makeSession('external-1')]);
    handlerFor('add')();

    // Debounced: nothing yet before the timer fires.
    await Promise.resolve();
    // Advance past the debounce window, then let the async rescan settle.
    await vi.advanceTimersByTimeAsync(300);

    const event = (await nextPromise).value as SessionListEvent;
    expect(event).toEqual({ type: 'session_upserted', session: makeSession('external-1') });
    await it.return?.();
  });

  // Coalescing: rapid add/change bursts collapse into a single rescan.
  it('debounces a burst of file events into a single rescan', async () => {
    listSessions.mockResolvedValueOnce([]); // initial
    const it = watchSessionList(reader as TranscriptReader, '/repo')[Symbol.asyncIterator]();
    const nextPromise = it.next();

    listSessions.mockResolvedValue([makeSession('s1')]);
    handlerFor('change')();
    handlerFor('change')();
    handlerFor('change')();

    await vi.advanceTimersByTimeAsync(300);
    await (
      await nextPromise
    ).value;

    // initial + exactly one rescan despite three change events.
    expect(listSessions).toHaveBeenCalledTimes(2);
    await it.return?.();
  });

  // A removed transcript surfaces as session_removed.
  it('emits session_removed when a transcript disappears', async () => {
    listSessions.mockResolvedValueOnce([makeSession('s1')]);
    const it = watchSessionList(reader as TranscriptReader, '/repo')[Symbol.asyncIterator]();
    await it.next(); // consume the initial upsert for s1

    const nextPromise = it.next();
    listSessions.mockResolvedValueOnce([]); // s1 gone
    handlerFor('unlink')();
    await vi.advanceTimersByTimeAsync(300);

    const event = (await nextPromise).value as SessionListEvent;
    expect(event).toEqual({ type: 'session_removed', sessionId: 's1' });
    await it.return?.();
  });

  // Closes the chokidar watcher when the consumer stops iterating, even while a
  // next() is still pending on an empty queue.
  it('closes the watcher on return and resolves a pending next()', async () => {
    listSessions.mockResolvedValueOnce([]);
    const it = watchSessionList(reader as TranscriptReader, '/repo')[Symbol.asyncIterator]();
    const pending = it.next(); // blocks: empty inventory, no events
    await it.return?.();
    expect(mockWatcher.close).toHaveBeenCalled();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
  });
});
