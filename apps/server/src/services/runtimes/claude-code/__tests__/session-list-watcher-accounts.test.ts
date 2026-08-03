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

/**
 * A chokidar mock that hands out a DISTINCT watcher per `watch()` call and
 * remembers which root each one was created for.
 *
 * The sibling `session-list-watcher.test.ts` shares one watcher object across
 * calls, which is fine for a single account but cannot express the question here:
 * whether each account's handlers judge events against their OWN root. Driving one
 * account's handler and asserting on another's behavior needs them kept apart.
 */
const { watchers, mockChokidar } = vi.hoisted(() => {
  type FakeWatcher = {
    target: string;
    handlers: Map<string, (path: string) => void>;
    close: ReturnType<typeof vi.fn>;
  };
  const watchers: FakeWatcher[] = [];
  return {
    watchers,
    mockChokidar: {
      watch: vi.fn((target: string) => {
        const watcher: FakeWatcher = {
          target,
          handlers: new Map(),
          close: vi.fn().mockResolvedValue(undefined),
        };
        const self = {
          on: (event: string, handler: (path: string) => void) => {
            watcher.handlers.set(event, handler);
            return self;
          },
          close: watcher.close,
        };
        watchers.push(watcher);
        return self;
      }),
    },
  };
});
vi.mock('chokidar', () => ({ default: mockChokidar }));

import { watchSessionList } from '../sessions/session-list-watcher.js';
import { logger } from '../../../../lib/logger.js';

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: `Session ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    ...overrides,
  };
}

/**
 * The fleet-wide watcher across SEVERAL Claude Code accounts (spec
 * `claude-code-accounts`). One watcher per account, and every guard inside it
 * judged against that account's own root.
 */
describe('watchSessionList across Claude accounts', () => {
  let tmp: string;
  /** `{account}/projects` for two accounts. */
  let rootA: string;
  let rootB: string;
  let slugInA: string;
  let slugInB: string;
  let reader: Pick<TranscriptReader, 'getProjectsRootSet' | 'listSessionsInDir'>;
  let listSessionsInDir: ReturnType<typeof vi.fn<(dir: string) => Promise<Session[]>>>;
  let inventory: Record<string, Session[]>;

  beforeEach(async () => {
    vi.clearAllMocks();
    watchers.length = 0;

    // Real directories: the initial inventory does a real fs.readdir.
    tmp = await mkdtemp(join(tmpdir(), 'watcher-accounts-'));
    rootA = join(tmp, 'claude-active', 'projects');
    rootB = join(tmp, '.claude', 'projects');
    slugInA = join(rootA, '-work-shared');
    slugInB = join(rootB, '-work-shared');
    await mkdir(slugInA, { recursive: true });
    await mkdir(slugInB, { recursive: true });

    inventory = { [slugInA]: [], [slugInB]: [] };
    listSessionsInDir = vi.fn(async (dir: string) => inventory[dir] ?? []);
    reader = { getProjectsRootSet: vi.fn(() => [rootA, rootB]), listSessionsInDir };
    // Fake ONLY the debounce timers; the initial inventory's fs I/O must still run
    // on the real event loop (see flushIo).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tmp, { recursive: true, force: true });
  });

  /** Let pending fs I/O (the detached initial-inventory scans) settle. */
  async function flushIoUntil(settled: () => boolean, turns = 500): Promise<void> {
    for (let i = 0; i < turns && !settled(); i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  function start(): AsyncIterator<SessionListEvent> {
    return watchSessionList(reader as TranscriptReader)[Symbol.asyncIterator]();
  }

  /** The watcher created for `root`, and one of its registered handlers. */
  function handlerFor(root: string, event: string): (path: string) => void {
    const watcher = watchers.find((w) => w.target === root);
    if (!watcher) throw new Error(`no watcher for ${root}`);
    const handler = watcher.handlers.get(event);
    if (!handler) throw new Error(`no ${event} handler on the watcher for ${root}`);
    return handler;
  }

  it('watches every account, one watcher each', async () => {
    const iterator = start();

    expect(mockChokidar.watch).toHaveBeenCalledTimes(2);
    expect(watchers.map((w) => w.target)).toEqual([rootA, rootB]);
    await iterator.return?.();
  });

  it('emits the initial inventory from every account', async () => {
    inventory[slugInA] = [makeSession('in-account-a', { cwd: '/work/shared' })];
    inventory[slugInB] = [makeSession('in-account-b', { cwd: '/work/shared' })];
    const iterator = start();

    const ids = [(await iterator.next()).value, (await iterator.next()).value].map(
      (e) => (e as Extract<SessionListEvent, { type: 'session_upserted' }>).session.id
    );

    // A watcher covering only the first account emits one of these, and a sidebar
    // showing half the history looks exactly like one showing all of it.
    expect(ids.sort()).toEqual(['in-account-a', 'in-account-b']);
    await iterator.return?.();
  });

  it('keeps one account rescan from removing another account copy of the same project', async () => {
    // Both accounts hold the SAME project slug. The last-known inventory is keyed
    // by absolute directory, so these are two independent entries — if they shared
    // a key, re-scanning one account would report the other's sessions as removed.
    inventory[slugInA] = [makeSession('in-account-a', { cwd: '/work/shared' })];
    inventory[slugInB] = [makeSession('in-account-b', { cwd: '/work/shared' })];
    const iterator = start();
    await iterator.next();
    await iterator.next();

    const pending = iterator.next();
    inventory[slugInA] = [
      makeSession('in-account-a', { cwd: '/work/shared', updatedAt: '2026-01-02T00:00:00.000Z' }),
    ];
    handlerFor(rootA, 'change')(join(slugInA, 'in-account-a.jsonl'));
    await vi.advanceTimersByTimeAsync(300);

    expect(await pending).toMatchObject({
      value: { type: 'session_upserted', session: { id: 'in-account-a' } },
    });
    await iterator.return?.();
  });

  it('rescans a NEW project directory that appears under the second account', async () => {
    // The misattribution this guards. `onDirEvent` accepts only immediate children
    // of its own root; a single captured root would judge account B's `addDir`
    // against account A's root, drop it, and lose the first session in a
    // brand-new project — lost, not late, because chokidar attaches a new dir's
    // own watch only after scanning it.
    const iterator = start();
    await flushIoUntil(() => listSessionsInDir.mock.calls.length >= 2);
    listSessionsInDir.mockClear();

    const freshSlug = join(rootB, '-work-brand-new');
    inventory[freshSlug] = [makeSession('first-in-new-project', { cwd: '/work/brand/new' })];
    handlerFor(rootB, 'addDir')(freshSlug);
    await vi.advanceTimersByTimeAsync(300);

    expect(listSessionsInDir).toHaveBeenCalledWith(freshSlug);
    await iterator.return?.();
  });

  it('ignores a stray .jsonl sitting directly in the second account root', async () => {
    // The mirror-image misattribution: judged against ANOTHER account's root, a
    // file at the top of this one looks like it sits in a slug dir, and the root
    // itself gets rescanned as though it were a project.
    const iterator = start();
    await flushIoUntil(() => listSessionsInDir.mock.calls.length >= 2);
    listSessionsInDir.mockClear();

    handlerFor(rootB, 'add')(join(rootB, 'stray.jsonl'));
    await vi.advanceTimersByTimeAsync(300);

    expect(listSessionsInDir).not.toHaveBeenCalled();
    await iterator.return?.();
  });

  it('closes every account watcher when the consumer stops', async () => {
    const iterator = start();

    await iterator.return?.();

    expect(watchers).toHaveLength(2);
    for (const watcher of watchers) expect(watcher.close).toHaveBeenCalled();
  });

  // Regression guard for the per-watcher error latch. If the `seenCodes` Set
  // were ever hoisted out of `watchRoot`'s closure to module or function scope,
  // one account's first EMFILE would wrongly suppress the other account's — and
  // the second account's session list would freeze with nothing in the log.
  it('scopes the watcher-error latch per account — each root logs its own first error', async () => {
    const iterator = start();
    await flushIoUntil(() => listSessionsInDir.mock.calls.length >= 2);

    const onErrorA = handlerFor(rootA, 'error') as unknown as (err: unknown) => void;
    const onErrorB = handlerFor(rootB, 'error') as unknown as (err: unknown) => void;
    expect(onErrorA).not.toBe(onErrorB);

    onErrorA(Object.assign(new Error('EMFILE A'), { code: 'EMFILE' }));
    onErrorB(Object.assign(new Error('EMFILE B'), { code: 'EMFILE' }));

    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[watcher-error] session-list-watcher'),
      expect.objectContaining({ projectsRoot: rootA, code: 'EMFILE' })
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[watcher-error] session-list-watcher'),
      expect.objectContaining({ projectsRoot: rootB, code: 'EMFILE' })
    );
    await iterator.return?.();
  });

  it('watches nothing and yields nothing when no account qualifies', async () => {
    // A freshly authenticated account has no `projects/` yet, so the set can be
    // empty even with an active account (spec §9). That is "no sessions", and it
    // must not throw or hang the broadcaster.
    (reader.getProjectsRootSet as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const iterator = start();

    expect(mockChokidar.watch).not.toHaveBeenCalled();
    await expect(iterator.return?.()).resolves.toEqual({ value: undefined, done: true });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });
});
