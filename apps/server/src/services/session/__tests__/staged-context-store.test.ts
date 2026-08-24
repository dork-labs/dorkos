import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import {
  StagedContextStore,
  holdStagedContext,
  takeStagedContext,
  setStagedContextStore,
  resetStagedContextStore,
} from '../staged-context-store.js';
import { linkSessionId, resetSessionKeys } from '../session-key-registry.js';
import { logger } from '../../../lib/logger.js';

const SESSION = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

const entry = (text: string) => ({
  kind: 'staged_context',
  scope: 'per-turn',
  data: { text },
});

let db: Db;

beforeEach(() => {
  db = createTestDb();
  setStagedContextStore(new StagedContextStore(db));
});

afterEach(() => {
  setStagedContextStore(undefined);
  resetStagedContextStore();
  resetSessionKeys();
  vi.restoreAllMocks();
});

describe('the hold behind "Added context for the next reply" outlives the process (DOR-1324)', () => {
  // The receipt is written to the DURABLE session stream the moment the words
  // are held. A hold that only lived in this process left that receipt pointing
  // at words the next turn would never carry — a permanent record of a silent
  // loss, which is the one thing ADR 260816-143752 does not allow.
  it('gives the words back after a restart', () => {
    holdStagedContext(SESSION, 'the API key is in .env.local', 'msg-1');

    // The restart: every scrap of process memory goes, and a new store opens
    // over the SAME database file.
    resetStagedContextStore();
    setStagedContextStore(new StagedContextStore(db));

    expect(takeStagedContext(SESSION)).toEqual([entry('the API key is in .env.local')]);
  });

  it('keeps several holds in the order they were staged, across the restart', () => {
    holdStagedContext(SESSION, 'first', 'msg-1');
    holdStagedContext(SESSION, 'second', 'msg-2');
    holdStagedContext(SESSION, 'third', 'msg-3');

    resetStagedContextStore();
    setStagedContextStore(new StagedContextStore(db));

    expect(takeStagedContext(SESSION)).toEqual([entry('first'), entry('second'), entry('third')]);
  });

  it('never lets one session read another session’s hold', () => {
    holdStagedContext(SESSION, 'mine', 'msg-1');
    holdStagedContext(OTHER, 'theirs', 'msg-2');

    expect(takeStagedContext(SESSION)).toEqual([entry('mine')]);
    expect(takeStagedContext(OTHER)).toEqual([entry('theirs')]);
  });

  // The crash-between-take-and-turn decision, pinned. The take deletes, so a
  // process that dies after taking loses the note rather than folding it into a
  // LATER turn as well — and it dies holding a turn that ADR-0264 already says
  // is lost.
  it('deletes what it took, so a restart mid-dispatch cannot ride the words twice', () => {
    holdStagedContext(SESSION, 'run it in staging', 'msg-1');
    expect(takeStagedContext(SESSION)).toEqual([entry('run it in staging')]);

    resetStagedContextStore();
    setStagedContextStore(new StagedContextStore(db));

    expect(takeStagedContext(SESSION)).toEqual([]);
  });

  it('holds nothing by default, and says so without touching anything', () => {
    expect(takeStagedContext(SESSION)).toEqual([]);
  });
});

// The seam the class-level rekey tests below cannot see. Every production caller
// goes through the module functions, and those resolve the row key themselves —
// so a store whose rows have moved onto the canonical id while the functions read
// by the FILING id loses the words under a receipt that has already gone out,
// which is the DOR-1324 bug wearing a different hat. `queueKeyOf` is the one
// resolver that follows the rows; `primaryOf` follows the in-memory state.
describe('a rename does not strand the hold, read through the module functions', () => {
  const REQUEST = SESSION;
  const CANON = OTHER;

  it('gives the words back under BOTH ids after the rename', () => {
    const store = new StagedContextStore(db);
    setStagedContextStore(store);
    holdStagedContext(REQUEST, 'staged before the rename', 'msg-1');

    // Exactly what the projector's rekey choke point does, in its order: link
    // the in-memory half, then carry the durable rows.
    linkSessionId(REQUEST, CANON);
    store.rekeySession(REQUEST, CANON);

    // The caller may still be holding either id — a client that never saw the
    // rename, or the turn that caused it.
    expect(takeStagedContext(CANON)).toEqual([entry('staged before the rename')]);
    holdStagedContext(REQUEST, 'staged again', 'msg-2');
    expect(takeStagedContext(REQUEST)).toEqual([entry('staged again')]);
  });

  it('writes a hold made AFTER the rename where the next dispatch will look', () => {
    const store = new StagedContextStore(db);
    setStagedContextStore(store);
    linkSessionId(REQUEST, CANON);

    holdStagedContext(REQUEST, 'staged after the rename', 'msg-1');

    // Not a second, invisible hold under the filing id: one hold, on the row key
    // the rows themselves live under.
    expect(store.take(CANON)).toEqual([entry('staged after the rename')]);
    expect(store.take(REQUEST)).toEqual([]);
  });
});

describe('StagedContextStore.rekeySession — a hold follows the session that was renamed', () => {
  it('carries the words onto the canonical id', () => {
    const store = new StagedContextStore(db);
    store.hold(SESSION, 'staged under the request uuid', 'msg-1');

    store.rekeySession(SESSION, OTHER);

    expect(store.take(SESSION)).toEqual([]);
    expect(store.take(OTHER)).toEqual([entry('staged under the request uuid')]);
  });

  it('appends behind a hold the destination already had, and is a no-op twice', () => {
    const store = new StagedContextStore(db);
    store.hold(OTHER, 'already there', 'msg-1');
    store.hold(SESSION, 'moved in', 'msg-2');

    store.rekeySession(SESSION, OTHER);
    store.rekeySession(SESSION, OTHER);

    expect(store.take(OTHER)).toEqual([entry('already there'), entry('moved in')]);
  });

  it('does nothing when the ids match', () => {
    const store = new StagedContextStore(db);
    store.hold(SESSION, 'stay', 'msg-1');
    store.rekeySession(SESSION, SESSION);
    expect(store.take(SESSION)).toEqual([entry('stay')]);
  });
});

describe('StagedContextStore.listSessionIds — the boot reconcile finds a hold nobody announced', () => {
  it('names each holding session once, however many notes it holds', () => {
    const store = new StagedContextStore(db);
    store.hold(SESSION, 'first', 'msg-1');
    store.hold(SESSION, 'second', 'msg-2');
    store.hold(OTHER, 'elsewhere', 'msg-3');

    expect(store.listSessionIds().sort()).toEqual([SESSION, OTHER].sort());
  });

  it('is empty when nothing is held', () => {
    expect(new StagedContextStore(db).listSessionIds()).toEqual([]);
  });
});

describe('StagedContextStore.deleteForSessions — a session that is gone keeps nothing', () => {
  it('drops the named sessions and leaves the rest alone', () => {
    const store = new StagedContextStore(db);
    store.hold(SESSION, 'doomed', 'msg-1');
    store.hold(OTHER, 'alive', 'msg-2');

    expect(store.deleteForSessions([SESSION])).toBe(1);

    expect(store.take(SESSION)).toEqual([]);
    expect(store.take(OTHER)).toEqual([entry('alive')]);
  });

  it('does nothing for an empty list', () => {
    const store = new StagedContextStore(db);
    expect(store.deleteForSessions([])).toBe(0);
  });
});

describe('the memory fallback — a host with no database still folds', () => {
  it('holds and returns the words when no store is wired', () => {
    setStagedContextStore(undefined);
    holdStagedContext(SESSION, 'no database here', 'msg-1');
    expect(takeStagedContext(SESSION)).toEqual([entry('no database here')]);
  });

  it('keeps the words when the database refuses the write, and says so loudly', () => {
    const broken = new StagedContextStore(db);
    vi.spyOn(broken, 'hold').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    setStagedContextStore(broken);
    const logged = vi.spyOn(logger, 'error');

    holdStagedContext(SESSION, 'still mine', 'msg-1');

    // The receipt has already gone out, so the words may not be dropped — but
    // the hold is now only as durable as the process, and that is not something
    // to keep quiet about.
    expect(logged).toHaveBeenCalledWith(
      '[StagedContextStore] could not hold staged context durably',
      expect.objectContaining({ messageId: 'msg-1' })
    );
    expect(takeStagedContext(SESSION)).toEqual([entry('still mine')]);
  });

  it('folds a read failure into an empty bag rather than losing the turn', () => {
    const broken = new StagedContextStore(db);
    vi.spyOn(broken, 'take').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    setStagedContextStore(broken);
    const logged = vi.spyOn(logger, 'error');

    expect(takeStagedContext(SESSION)).toEqual([]);
    expect(logged).toHaveBeenCalledWith(
      '[StagedContextStore] could not read staged context',
      expect.objectContaining({ sessionId: SESSION })
    );
  });
});
