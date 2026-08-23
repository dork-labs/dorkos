import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { reconcileSessionRows } from '../reconcile-session-rows.js';
import { MessageQueueStore } from '../message-queue-store.js';
import { StagedContextStore } from '../staged-context-store.js';

/**
 * The boot reconcile (DOR-1436): rows whose session disappeared while the
 * server was DOWN, and the three guards that stop it deleting anybody's words.
 *
 * Real stores over a real (in-memory) database, because the thing under test is
 * which rows survive — a mocked store would only assert that this file's own
 * arithmetic was passed on.
 */

/** A live claude-code session — its transcript is still on disk. */
const LIVE = '00000000-0000-4000-8000-00000000live';
/** A claude-code session whose transcript was deleted while the server was off. */
const GONE = '00000000-0000-4000-8000-00000000gone';
/** A session owned by a runtime this reconcile cannot read. */
const CODEX = '00000000-0000-4000-8000-0000000codex';
/** A session that has never started, so nothing has claimed it. */
const UNBOUND = '00000000-0000-4000-8000-000000unbound';

let db: Db;
let queue: MessageQueueStore;
let staged: StagedContextStore;

/** Put one queued message and one held note on each of the named sessions. */
function seed(sessionIds: string[]): void {
  for (const sessionId of sessionIds) {
    queue.enqueue({ sessionId, content: `queued for ${sessionId}`, clientId: 'w1' });
    staged.hold(sessionId, `staged for ${sessionId}`, `msg-${sessionId}`);
  }
}

/** The deps every case starts from: everything alive, inventory complete. */
function deps(overrides?: {
  inventory?: () => Promise<{ ids: Set<string>; complete: boolean }>;
  owners?: Map<string, string>;
}) {
  return {
    queue,
    staged,
    boundRuntimesFor: () =>
      overrides?.owners ??
      new Map([
        [LIVE, 'claude-code'],
        [GONE, 'claude-code'],
        [CODEX, 'codex'],
      ]),
    claudeCodeInventory:
      overrides?.inventory ?? (() => Promise.resolve({ ids: new Set([LIVE]), complete: true })),
  };
}

/** Which sessions still hold rows, in either table. */
function survivors(): string[] {
  return [...new Set([...queue.listSessionIds(), ...staged.listSessionIds()])].sort();
}

beforeEach(() => {
  db = createTestDb();
  queue = new MessageQueueStore(db);
  staged = new StagedContextStore(db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reconcileSessionRows — only the session its owner says is gone loses its rows', () => {
  it('clears the vanished session and leaves every other one untouched', async () => {
    seed([LIVE, GONE, CODEX, UNBOUND]);

    const report = await reconcileSessionRows(deps());

    // One queue row and one staged row, for the one session with no transcript.
    expect(report).toEqual({
      candidates: 4,
      reaped: 1,
      rows: 2,
      kept: 3,
      inventoryComplete: true,
    });
    expect(survivors()).toEqual([CODEX, LIVE, UNBOUND].sort());
  });

  it('clears BOTH tables for it, not just the queue', async () => {
    seed([GONE]);

    await reconcileSessionRows(deps());

    expect(queue.list(GONE)).toEqual([]);
    expect(staged.take(GONE)).toEqual([]);
  });

  it('leaves a session that holds only staged words but is still on disk', async () => {
    staged.hold(LIVE, 'the key is in .env.local', 'msg-1');

    const report = await reconcileSessionRows(deps());

    expect(report.reaped).toBe(0);
    expect(staged.take(LIVE)).toHaveLength(1);
  });

  it('reports a clean database without touching anything', async () => {
    const report = await reconcileSessionRows(deps());

    expect(report).toEqual({
      candidates: 0,
      reaped: 0,
      rows: 0,
      kept: 0,
      inventoryComplete: true,
    });
  });
});

describe('reconcileSessionRows — a degraded runtime keeps every one of its rows', () => {
  // The guard that matters most. An unreadable Claude account or project
  // directory makes EVERY id under it look absent, so acting on a partial
  // inventory would delete the queued words of sessions that are perfectly
  // alive — a mass false positive, on somebody's own typing.
  it('deletes nothing at all when the inventory is incomplete', async () => {
    seed([LIVE, GONE, CODEX, UNBOUND]);

    const report = await reconcileSessionRows(
      deps({ inventory: () => Promise.resolve({ ids: new Set([LIVE]), complete: false }) })
    );

    expect(report).toEqual({
      candidates: 4,
      reaped: 0,
      rows: 0,
      kept: 4,
      inventoryComplete: false,
    });
    expect(survivors()).toEqual([CODEX, GONE, LIVE, UNBOUND].sort());
  });

  it('keeps everything when the inventory probe throws outright', async () => {
    seed([GONE]);

    const report = await reconcileSessionRows(
      deps({ inventory: () => Promise.reject(new Error('EACCES')) })
    );

    expect(report.inventoryComplete).toBe(false);
    expect(report.reaped).toBe(0);
    expect(queue.list(GONE)).toHaveLength(1);
  });

  it('keeps the rows of a session owned by a runtime it cannot read', async () => {
    // Codex keeps its sessions in the SDK's thread store, which this probe never
    // looked at. Absent from a claude-code inventory says nothing about it.
    seed([CODEX]);

    const report = await reconcileSessionRows(deps());

    expect(report.reaped).toBe(0);
    expect(queue.list(CODEX)).toHaveLength(1);
  });

  it('keeps the rows of a session that has never started', async () => {
    // Words staged into a session before its first turn: no runtime has claimed
    // it, so it has no transcript yet — which is not the same as having lost one.
    seed([UNBOUND]);

    const report = await reconcileSessionRows(deps());

    expect(report.reaped).toBe(0);
    expect(staged.take(UNBOUND)).toHaveLength(1);
  });

  it('keeps everything when the ownership read throws', async () => {
    seed([GONE]);

    const report = await reconcileSessionRows({
      ...deps(),
      boundRuntimesFor: () => {
        throw new Error('database is locked');
      },
    });

    expect(report.reaped).toBe(0);
    expect(queue.list(GONE)).toHaveLength(1);
  });

  it('survives a delete that fails and still reports', async () => {
    seed([GONE]);

    const report = await reconcileSessionRows({
      ...deps(),
      queue: {
        listSessionIds: () => queue.listSessionIds(),
        deleteForSessions: () => {
          throw new Error('database is locked');
        },
      },
    });

    expect(report).toEqual({
      candidates: 1,
      reaped: 0,
      rows: 0,
      kept: 1,
      inventoryComplete: true,
    });
  });

  it('survives a row read that fails and judges nothing', async () => {
    const report = await reconcileSessionRows({
      ...deps(),
      queue: {
        listSessionIds: () => {
          throw new Error('database is locked');
        },
        deleteForSessions: () => 0,
      },
    });

    expect(report).toEqual({
      candidates: 0,
      reaped: 0,
      rows: 0,
      kept: 0,
      inventoryComplete: false,
    });
  });
});
