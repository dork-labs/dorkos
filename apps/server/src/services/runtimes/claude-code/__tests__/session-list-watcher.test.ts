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

import {
  SESSION_LIST_DEBOUNCE_MS,
  SESSION_LIST_RECONCILE_MS,
  watchSessionList,
} from '../sessions/session-list-watcher.js';
import { logger } from '../../../../lib/logger.js';

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

/** Resolve the watcher's registered 'error' handler. */
function errorHandler(): (err: unknown) => void {
  const call = mockWatcher.on.mock.calls.find(([e]) => e === 'error');
  if (!call) throw new Error('no error handler registered');
  return call[1] as (err: unknown) => void;
}

describe('watchSessionList', () => {
  // A REAL temp projects root (the initial inventory enumerates it with
  // fs.readdir); only chokidar and the per-dir listing are faked.
  let projectsRoot: string;
  let dirA: string;
  let dirB: string;
  let reader: Pick<TranscriptReader, 'getProjectsRootSet' | 'listSessionsInDir'>;
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
      getProjectsRootSet: vi.fn(() => [projectsRoot]),
      listSessionsInDir,
    };
    // Fake ONLY the debounce timers: the initial inventory does real fs.readdir
    // I/O, which must still complete on the real event loop (see flushIoUntil).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  /**
   * Turn the real event loop until `settled()` reports the pending fs I/O (the
   * detached initial-inventory scan) has landed.
   *
   * Waiting a fixed number of turns is a guess about how long real fs I/O takes,
   * and the guess is machine-dependent: ten turns of an otherwise-idle loop go by
   * in well under a millisecond, while `fs.readdir` is a threadpool call a busy
   * CI runner can take far longer to answer. Both flakes this file has thrown in
   * CI were that guess coming up short. Waiting on the condition cannot flake in
   * either direction — it returns as soon as the work is done, and it says so
   * loudly if the work never arrives at all. The deadline sits under Vitest's
   * 5s test timeout on purpose: a longer one would never fire, and the
   * diagnostic below would be unreachable code dressed as a safety net.
   *
   * Fake timers are on for `setTimeout` here, so `vi.waitFor` is not usable;
   * `setImmediate` and `Date.now` are deliberately left real (see the `toFake`
   * list above).
   */
  async function flushIoUntil(settled: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!settled()) {
      if (Date.now() > deadline) {
        throw new Error(`flushIoUntil: pending fs I/O never settled within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Wait until the detached initial inventory has listed BOTH seeded slug dirs.
   *
   * Every `listSessionsInDir.mockClear()` below must follow this. The initial
   * scan runs off the event loop, so a clear that lands mid-scan is followed by
   * the scan's own listing calls, and a test asserting "this event triggered no
   * rescan" then counts those as the rescan. That is exactly how CI read it:
   * `expected "vi.fn()" to not be called at all, but actually been called 2
   * times` — one late call per seeded dir.
   */
  async function awaitInitialScan(): Promise<void> {
    await flushIoUntil(() =>
      [dirA, dirB].every((dir) => listSessionsInDir.mock.calls.some(([arg]) => arg === dir))
    );
  }

  /**
   * Await the next event with NO chokidar event to help it along, so the
   * reconcile sweep is the only thing that can produce one.
   *
   * Neither kind of pumping gets there alone: the sweep only starts when the
   * faked clock reaches it, its `readdir`/`stat` only land when the REAL loop
   * turns, and the rescan it schedules only fires when the faked clock moves
   * again. Alternating the two until the event arrives keeps this a wait on the
   * condition rather than a guess about how long real fs I/O takes — the same
   * lesson {@link flushIoUntil} records.
   */
  async function nextEventViaSweep(
    it: AsyncIterator<SessionListEvent>,
    timeoutMs = 5_000
  ): Promise<SessionListEvent> {
    let event: SessionListEvent | undefined;
    void it.next().then((result) => {
      if (!result.done) event = result.value;
    });
    const deadline = Date.now() + timeoutMs;
    while (event === undefined) {
      if (Date.now() > deadline) {
        throw new Error(`nextEventViaSweep: no event from the sweep within ${timeoutMs}ms`);
      }
      await vi.advanceTimersByTimeAsync(SESSION_LIST_RECONCILE_MS + SESSION_LIST_DEBOUNCE_MS);
      await new Promise((resolve) => setImmediate(resolve));
    }
    return event;
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
    await awaitInitialScan();
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
    await awaitInitialScan();
    listSessionsInDir.mockClear();

    const nextPromise = it.next();
    inventory[dirA] = []; // dir gone: the reader now serves []
    handlerFor('unlinkDir')(dirA);
    await vi.advanceTimersByTimeAsync(300);

    expect((await nextPromise).value).toEqual({ type: 'session_removed', sessionId: 'alpha-1' });
    await it.return?.();
  });

  // DOR-577. Every test above hands the watcher a chokidar event; these two
  // hand it NOTHING, because that is the measured failure. `chokidar.watch()`
  // scans the root before it attaches `fs.watch` to it, and on the installed
  // chokidar 5.0.0 a project dir created inside that window produced no
  // `addDir` and no `add` in 35 of 35 runs — so the mocked watcher staying
  // silent here is not a convenient stand-in for the bug, it IS the bug. The
  // filesystem underneath is real, and the reconcile sweep reads it.
  it('discovers a slug dir chokidar never reported at all', async () => {
    const it = start();
    await awaitInitialScan();

    const dirC = join(projectsRoot, '-work-gamma');
    await mkdir(dirC);
    inventory[dirC] = [makeSession('gamma-1', { cwd: '/work/gamma' })];

    expect(await nextEventViaSweep(it)).toEqual({
      type: 'session_upserted',
      session: makeSession('gamma-1', { cwd: '/work/gamma' }),
    });
    await it.return?.();
  });

  // The other direction: a slug dir that disappears with no `unlinkDir` still
  // owes its sessions a removal, or the sidebar keeps offering a project that
  // is no longer on disk.
  it('removes the sessions of a slug dir that vanished with no chokidar event', async () => {
    inventory[dirA] = [makeSession('alpha-1')];
    const it = start();
    await it.next(); // drain the initial upsert
    await awaitInitialScan();

    await rm(dirA, { recursive: true, force: true });
    inventory[dirA] = []; // dir gone: the reader now serves []

    expect(await nextEventViaSweep(it)).toEqual({
      type: 'session_removed',
      sessionId: 'alpha-1',
    });
    await it.return?.();
  });

  // The guard admits only immediate children of the root: an addDir for the
  // root itself is not a slug dir and must not trigger a rescan.
  it('ignores addDir for the projects root itself', async () => {
    const it = start();
    await awaitInitialScan();
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
    await awaitInitialScan();
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
    await awaitInitialScan();
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

  // A missing projects root is the normal first-run state (Claude Code never
  // ran on this machine) — it must boot quietly, not as a WARN-level "failed"
  // scan (DOR-247). Real scan failures on an existing root still WARN.
  it('logs at debug, not warn, when the projects root does not exist yet', async () => {
    const missingRoot = join(projectsRoot, 'does-not-exist');
    (reader.getProjectsRootSet as ReturnType<typeof vi.fn>).mockReturnValue([missingRoot]);
    const it = start();
    // Wait for the scan to actually report, not for a fixed number of turns:
    // this is the assertion that went red twice in CI purely because the
    // detached scan had not finished inside 10 turns on a slower disk.
    await flushIoUntil(() => vi.mocked(logger.debug).mock.calls.length > 0);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      '[session-list-watcher] no sessions yet; projects directory not created',
      { projectsRoot: missingRoot }
    );
    await it.return?.();
  });

  // A dead watcher (e.g. EMFILE when the process runs out of file descriptors)
  // must be logged with enough context to identify the watcher, never left to
  // surface as unhandled-error spam. See
  // session-list-watcher.real-emfile.test.ts for proof chokidar really does
  // emit 'error' for a genuine EMFILE, on real hardware.
  it('logs a watcher error at error level, naming the projects root and the code', async () => {
    const it = start();
    await awaitInitialScan();

    const err = Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    errorHandler()(err);

    expect(logger.error).toHaveBeenCalledWith(
      '[watcher-error] session-list-watcher — further EMFILE errors from this watcher are suppressed',
      {
        projectsRoot,
        code: 'EMFILE',
        message: 'EMFILE: too many open files',
        stack: err.stack,
        suppressingFurtherErrors: true,
      }
    );
    await it.return?.();
  });

  it('stringifies a non-Error thrown as the watcher error, with no stack and code "unknown"', async () => {
    const it = start();
    await awaitInitialScan();

    errorHandler()('EMFILE');

    expect(logger.error).toHaveBeenCalledWith(
      '[watcher-error] session-list-watcher — further unknown errors from this watcher are suppressed',
      {
        projectsRoot,
        code: 'unknown',
        message: 'EMFILE',
        stack: undefined,
        suppressingFurtherErrors: true,
      }
    );
    await it.return?.();
  });

  // A dead root watcher spans every project dir, so a single fd-exhaustion
  // episode can make chokidar fire 'error' once per directory it fails to
  // (re-)watch — hundreds of times for a real tree. The handler must latch: log
  // the first, drop repeats of the same code.
  it('logs only the first of many errors carrying the same code', async () => {
    const it = start();
    await awaitInitialScan();
    const onError = errorHandler();

    onError(Object.assign(new Error('EMFILE 1'), { code: 'EMFILE' }));
    onError(Object.assign(new Error('EMFILE 2'), { code: 'EMFILE' }));
    onError(Object.assign(new Error('EMFILE 3'), { code: 'EMFILE' }));

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[watcher-error] session-list-watcher'),
      expect.objectContaining({ code: 'EMFILE', message: 'EMFILE 1' })
    );
    await it.return?.();
  });

  // The masking bug: a latch keyed on "any error at all" would let one benign
  // EACCES on a stale project dir hide a real EMFILE storm that follows it.
  // Keying on `code` means a NEW code always gets its own line.
  it('logs a separate line for each distinct error code', async () => {
    const it = start();
    await awaitInitialScan();
    const onError = errorHandler();

    onError(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    onError(Object.assign(new Error('too many open files'), { code: 'EMFILE' }));

    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[watcher-error] session-list-watcher'),
      expect.objectContaining({ code: 'EACCES' })
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[watcher-error] session-list-watcher'),
      expect.objectContaining({ code: 'EMFILE' })
    );
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
