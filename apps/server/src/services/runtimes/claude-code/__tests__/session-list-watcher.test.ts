import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
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
function handlerFor(
  event: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
): (path: string) => void {
  const call = mockWatcher.on.mock.calls.find(([e]) => e === event);
  if (!call) throw new Error(`no ${event} handler registered`);
  return call[1] as (path: string) => void;
}

describe('watchSessionList', () => {
  // A REAL temp projects root (the initial inventory enumerates it with
  // fs.readdir); only chokidar and the per-dir listing are faked.
  let projectsRoot: string;
  let dirA: string;
  let dirB: string;
  let reader: Pick<TranscriptReader, 'getProjectsRoot' | 'listSessionsInDir'>;
  let listSessionsInDir: ReturnType<typeof vi.fn>;
  /** Canned per-dir inventories the fake reader serves. */
  let inventory: Record<string, Session[]>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockWatcher.on.mockReturnValue(mockWatcher);
    mockWatcher.close.mockResolvedValue(undefined);
    mockChokidar.watch.mockReturnValue(mockWatcher);

    projectsRoot = await mkdtemp(join(tmpdir(), 'session-list-watcher-'));
    dirA = join(projectsRoot, '-work-alpha');
    dirB = join(projectsRoot, '-work-beta');
    await mkdir(dirA);
    await mkdir(dirB);

    inventory = { [dirA]: [], [dirB]: [] };
    listSessionsInDir = vi.fn(async (dir: string) => inventory[dir] ?? []);
    reader = {
      getProjectsRoot: vi.fn(() => projectsRoot),
      listSessionsInDir,
    };
    // Fake ONLY the debounce timers: the initial inventory does real fs.readdir
    // I/O, which must still complete on the real event loop (see flushIo).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  /** Let pending fs I/O (the detached initial-inventory scan) settle. */
  async function flushIo(): Promise<void> {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  afterEach(async () => {
    vi.useRealTimers();
    await rm(projectsRoot, { recursive: true, force: true });
  });

  function start(): AsyncIterator<SessionListEvent> {
    return watchSessionList(reader as TranscriptReader)[Symbol.asyncIterator]();
  }

  // REGRESSION (chokidar v4+ removed glob support): the watch target must be
  // the projects ROOT directory, never a `*.jsonl` glob — a glob watches a
  // literal path that never exists, so no discovery event ever fires.
  it('watches the projects root directory, not a glob pattern', () => {
    const it = start();

    expect(mockChokidar.watch).toHaveBeenCalledTimes(1);
    const [target, opts] = mockChokidar.watch.mock.calls[0]!;
    expect(target).toBe(projectsRoot);
    expect(target).not.toContain('*');
    expect(opts).toMatchObject({ ignoreInitial: true, depth: 1 });
    void it.return?.();
  });

  // The initial on-disk inventory covers EVERY slug dir (fleet-wide, SRV-I4).
  it('emits session_upserted for every session across all project dirs', async () => {
    inventory[dirA] = [makeSession('alpha-1', { cwd: '/work/alpha' })];
    inventory[dirB] = [makeSession('beta-1', { cwd: '/work/beta' })];
    const it = start();

    const first = await it.next();
    const second = await it.next();

    const ids = [first.value, second.value].map(
      (e) => (e as Extract<SessionListEvent, { type: 'session_upserted' }>).session.id
    );
    expect(ids.sort()).toEqual(['alpha-1', 'beta-1']);
    await it.return?.();
  });

  // An EXTERNAL JSONL write (Claude Code CLI) in ANY project dir surfaces as
  // session_upserted, debounced — including a dir outside the default cwd.
  it('emits session_upserted for an externally-created session in a non-default dir', async () => {
    const it = start();
    const nextPromise = it.next();

    inventory[dirB] = [makeSession('external-1', { cwd: '/work/beta' })];
    handlerFor('add')(join(dirB, 'external-1.jsonl'));
    await vi.advanceTimersByTimeAsync(300);

    const event = (await nextPromise).value as SessionListEvent;
    expect(event).toEqual({
      type: 'session_upserted',
      session: makeSession('external-1', { cwd: '/work/beta' }),
    });
    await it.return?.();
  });

  // Non-transcript files (e.g. editor temp files) never trigger a rescan.
  it('ignores non-jsonl file events', async () => {
    const it = start();
    // Drain the (empty) initial inventory's listing calls.
    await flushIo();
    listSessionsInDir.mockClear();

    handlerFor('add')(join(dirA, 'notes.txt'));
    await vi.advanceTimersByTimeAsync(300);

    expect(listSessionsInDir).not.toHaveBeenCalled();
    await it.return?.();
  });

  // A brand-new slug dir (chokidar addDir) triggers a debounced rescan of that
  // dir — the recovery path for chokidar's scan-then-attach window, where the
  // first session's per-file add can be lost, not late.
  it('rescans a new slug dir on addDir and emits its sessions', async () => {
    const it = start();
    const nextPromise = it.next();

    const dirC = join(projectsRoot, '-work-gamma');
    inventory[dirC] = [makeSession('gamma-1', { cwd: '/work/gamma' })];
    handlerFor('addDir')(dirC);
    await vi.advanceTimersByTimeAsync(300);

    const event = (await nextPromise).value as SessionListEvent;
    expect(event).toEqual({
      type: 'session_upserted',
      session: makeSession('gamma-1', { cwd: '/work/gamma' }),
    });
    await it.return?.();
  });

  // Removing a slug dir (chokidar unlinkDir) rescans it; the reader lists an
  // absent dir as [], so every session that lived there is removed.
  it('emits session_removed for a slug dir removed via unlinkDir', async () => {
    inventory[dirA] = [makeSession('alpha-1')];
    const it = start();
    await it.next(); // drain the initial upsert
    await flushIo();
    listSessionsInDir.mockClear();

    const nextPromise = it.next();
    inventory[dirA] = []; // dir gone: the reader now serves []
    handlerFor('unlinkDir')(dirA);
    await vi.advanceTimersByTimeAsync(300);

    expect((await nextPromise).value).toEqual({ type: 'session_removed', sessionId: 'alpha-1' });
    await it.return?.();
  });

  // The guard admits only immediate children of the root: an addDir for the
  // root itself is not a slug dir and must not trigger a rescan.
  it('ignores addDir for the projects root itself', async () => {
    const it = start();
    await flushIo();
    listSessionsInDir.mockClear();

    handlerFor('addDir')(projectsRoot);
    await vi.advanceTimersByTimeAsync(300);

    expect(listSessionsInDir).not.toHaveBeenCalled();
    await it.return?.();
  });

  // Per-dir scoping: a burst in one project re-scans ONLY that project, and a
  // re-scan returning fewer sessions cannot remove another project's sessions.
  it('scopes rescans and removals to the changed project dir', async () => {
    inventory[dirA] = [makeSession('alpha-1')];
    inventory[dirB] = [makeSession('beta-1')];
    const it = start();
    await it.next();
    await it.next(); // drain the two initial upserts
    await flushIo();
    listSessionsInDir.mockClear();

    const nextPromise = it.next();
    inventory[dirA] = []; // alpha-1 deleted; beta untouched
    handlerFor('unlink')(join(dirA, 'alpha-1.jsonl'));
    handlerFor('change')(join(dirA, 'alpha-1.jsonl'));
    await vi.advanceTimersByTimeAsync(300);

    expect((await nextPromise).value).toEqual({ type: 'session_removed', sessionId: 'alpha-1' });
    // Exactly one rescan (debounced burst), and only for dirA.
    expect(listSessionsInDir).toHaveBeenCalledTimes(1);
    expect(listSessionsInDir).toHaveBeenCalledWith(dirA);
    await it.return?.();
  });

  // An unchanged inventory is suppressed (no metadata-irrelevant spam).
  it('suppresses an upsert when session metadata is unchanged', async () => {
    inventory[dirA] = [makeSession('alpha-1')];
    const it = start();
    await it.next(); // initial upsert
    await flushIo();
    listSessionsInDir.mockClear();

    handlerFor('change')(join(dirA, 'alpha-1.jsonl'));
    await vi.advanceTimersByTimeAsync(300);

    // Rescan happened but emitted nothing: a subsequent real change still flows.
    expect(listSessionsInDir).toHaveBeenCalledTimes(1);
    const pending = it.next();
    inventory[dirA] = [makeSession('alpha-1', { updatedAt: '2026-01-02T00:00:00.000Z' })];
    handlerFor('change')(join(dirA, 'alpha-1.jsonl'));
    await vi.advanceTimersByTimeAsync(300);
    expect(((await pending).value as SessionListEvent).type).toBe('session_upserted');
    await it.return?.();
  });

  // Closes the chokidar watcher when the consumer stops iterating, even while a
  // next() is still pending on an empty queue.
  it('closes the watcher on return and resolves a pending next()', async () => {
    const it = start();
    const pending = it.next(); // blocks: empty inventory, no events
    await it.return?.();
    expect(mockWatcher.close).toHaveBeenCalled();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
  });
});
