/**
 * A room's binding converges on the session that holds the conversation
 * (DOR-784).
 *
 * Three defects, one incident. The room mints a placeholder session id before
 * the first turn; Claude Code renames the session mid-turn; and the only thing
 * that used to notice was a single comparison at the END of the turn, against a
 * value the turn was routinely too early to know. So:
 *
 * 1. Turn 1 kept the placeholder, and the room lost its memory before message
 *    two. Pinned here by driving a rekey with the turn still open.
 * 2. When the return value finally arrived it was the STALE id, and the
 *    unguarded UPDATE moved the binding back onto it — the oscillation observed
 *    live (00dfdce7→0e7270c6→00dfdce7).
 * 3. A binding already stranded stayed stranded, silently, forever.
 *
 * The transcript probe is the real question the sweep asks — "is there a JSONL
 * file for this session under this agent's directory" — so it is injected here
 * rather than faked at the store, and the runtime resolution is the one the
 * runner ships (`resolveRoomRuntimeType`), not a copy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { eq, roomSessions } from '@dorkos/db';
import { RoomStore } from '../room-store.js';
import { RoomSessionLedger } from '../room-session-ledger.js';
import {
  followSessionRekeys,
  repairRoomSessionBindings,
  type RoomBindingRepairDeps,
} from '../room-session-convergence.js';
import { getOrCreateProjector, disposeProjector, rekeyProjector } from '../../session/index.js';
import { logger } from '../../../lib/logger.js';

/** The placeholder `room-trigger.ts` mints before the first turn. */
const PLACEHOLDER = '00dfdce7-1111-4222-8333-444444444444';
/** The id Claude Code names the session with, mid-turn. */
const CANONICAL = '0e7270c6-5555-4666-8777-888888888888';

const ROOM = 'room-backend';
const ANA = 'author-ana';
const ANA_PATH = '/agents/ana';

/** A store with Ana bound to the placeholder, the way turn 1 leaves it. */
function storeBoundToPlaceholder(): { store: RoomStore; db: ReturnType<typeof createTestDb> } {
  const db = createTestDb();
  const store = new RoomStore(db);
  store.bindRoomSession(ROOM, ANA, PLACEHOLDER, new Date().toISOString());
  return { store, db };
}

/** What `room_sessions` currently says Ana answers with in this room. */
function bound(db: ReturnType<typeof createTestDb>): string | null {
  const row = db.select().from(roomSessions).where(eq(roomSessions.roomId, ROOM)).get();
  return row?.sessionId ?? null;
}

describe('a room binding follows the projector rekey', () => {
  let unsubscribe: (() => void) | undefined;

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = undefined;
    disposeProjector(PLACEHOLDER);
    disposeProjector(CANONICAL);
  });

  it('converges on turn 1, without waiting for the turn to end', () => {
    const { store, db } = storeBoundToPlaceholder();
    unsubscribe = followSessionRekeys(store);
    // A real projector under the placeholder is what `rekeyProjector` moves —
    // the listener only fires for a rekey that actually happened.
    getOrCreateProjector(PLACEHOLDER, ANA_PATH);

    rekeyProjector(PLACEHOLDER, CANONICAL);

    // No turn has ended. The old code learned the canonical id only from
    // `runOne`'s return value, so at this point it still held the placeholder.
    expect(bound(db)).toBe(CANONICAL);
  });

  it('leaves a room alone when the renamed session is not one it binds', () => {
    const { store, db } = storeBoundToPlaceholder();
    unsubscribe = followSessionRekeys(store);
    getOrCreateProjector('some-other-session', '/agents/bo');

    rekeyProjector('some-other-session', 'some-other-canonical');

    expect(bound(db)).toBe(PLACEHOLDER);
  });

  it('survives a store that throws, so one bad rebind cannot break the rename', () => {
    const { store } = storeBoundToPlaceholder();
    vi.spyOn(store.sessionLedger, 'rebindBySessionId').mockImplementation(() => {
      throw new Error('database is locked');
    });
    unsubscribe = followSessionRekeys(store);
    getOrCreateProjector(PLACEHOLDER, ANA_PATH);

    expect(() => rekeyProjector(PLACEHOLDER, CANONICAL)).not.toThrow();
  });
});

describe('a binding is never moved back onto a retired id', () => {
  it('refuses the reversal and says so, with both ids', () => {
    const { store, db } = storeBoundToPlaceholder();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // The rename, as the listener applies it.
    store.sessionLedger.rebindBySessionId(PLACEHOLDER, CANONICAL);
    expect(bound(db)).toBe(CANONICAL);

    // Then `runOne`'s late comparison, carrying the id the turn was ASKED with.
    // This is the exact write that produced the observed oscillation.
    store.rebindRoomSession(ROOM, ANA, PLACEHOLDER);

    expect(bound(db)).toBe(CANONICAL);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('retired session id'),
      expect.objectContaining({
        roomId: ROOM,
        retiredSessionId: PLACEHOLDER,
        canonicalSessionId: CANONICAL,
      })
    );
    warn.mockRestore();
  });

  it('still allows a forward move onto an id nothing has retired', () => {
    // The guard must refuse REVERSALS, not rebinding. A session renamed twice
    // (the SDK can assign a new id on a resume) has to keep being followed.
    const { store, db } = storeBoundToPlaceholder();
    store.sessionLedger.rebindBySessionId(PLACEHOLDER, CANONICAL);

    store.rebindRoomSession(ROOM, ANA, 'sdk-third-name');

    expect(bound(db)).toBe('sdk-third-name');
  });

  it('remembers what replaced a retired id, and nothing about a live one', () => {
    const { store } = storeBoundToPlaceholder();
    store.sessionLedger.rebindBySessionId(PLACEHOLDER, CANONICAL);

    expect(store.sessionLedger.successorFor(PLACEHOLDER)).toBe(CANONICAL);
    expect(store.sessionLedger.successorFor(CANONICAL)).toBeUndefined();
  });

  it('refuses the reversal on the first request after a restart (DOR-1205)', () => {
    // The retirement used to live in one process's memory, so the refusal did
    // not exist until THIS process had personally watched the rename — and the
    // write that reverses a binding is exactly the one a turn still in flight
    // makes across a restart.
    const { store, db } = storeBoundToPlaceholder();
    store.sessionLedger.rebindBySessionId(PLACEHOLDER, CANONICAL);

    // A brand-new store over the same database: nothing is carried across.
    const rebooted = new RoomStore(db);
    expect(rebooted.sessionLedger.successorFor(PLACEHOLDER)).toBe(CANONICAL);

    rebooted.rebindRoomSession(ROOM, ANA, PLACEHOLDER);
    expect(bound(db)).toBe(CANONICAL);
  });

  it('follows a chain of renames to the id that is live now', () => {
    // The SDK can rename a session again on a resume, and across restarts a
    // second rename is no longer an event one process saw the whole of. A
    // binding stranded on the FIRST id has to reach the last one — repairing it
    // to a middle id would move it onto another dead session.
    const { store } = storeBoundToPlaceholder();
    store.sessionLedger.rebindBySessionId(PLACEHOLDER, CANONICAL);
    store.sessionLedger.rebindBySessionId(CANONICAL, 'sdk-third-name');

    expect(store.sessionLedger.successorFor(PLACEHOLDER)).toBe('sdk-third-name');
    expect(store.sessionLedger.successorFor(CANONICAL)).toBe('sdk-third-name');
  });

  it('never answers with the id it was asked about, however tangled the table', () => {
    // Two processes writing renames across a restart is not a structure SQLite
    // enforces anything about, and a chase that came back to where it started
    // would let the repair sweep "fix" a binding onto the same dead session and
    // count it as repaired.
    const db = createTestDb();
    const ledger = new RoomSessionLedger(db);
    ledger.retire(PLACEHOLDER, CANONICAL);
    ledger.retire(CANONICAL, PLACEHOLDER);

    expect(ledger.successorFor(PLACEHOLDER)).toBe(CANONICAL);
    expect(ledger.successorFor(CANONICAL)).toBe(PLACEHOLDER);
  });

  it('forgets a retirement older than the horizon, so the table cannot grow forever', () => {
    const db = createTestDb();
    let now = Date.UTC(2026, 0, 1);
    const ledger = new RoomSessionLedger(db, () => now);
    ledger.retire('ancient', 'ancient-successor');

    // A year later, another rename lands and prunes what has aged out.
    now += 365 * 24 * 60 * 60_000;
    ledger.retire(PLACEHOLDER, CANONICAL);

    expect(ledger.successorFor('ancient')).toBeUndefined();
    expect(ledger.successorFor(PLACEHOLDER)).toBe(CANONICAL);
  });

  it('keeps a retirement that is merely old, well inside the horizon', () => {
    const db = createTestDb();
    let now = Date.UTC(2026, 0, 1);
    const ledger = new RoomSessionLedger(db, () => now);
    ledger.retire(PLACEHOLDER, CANONICAL);

    now += 20 * 24 * 60 * 60_000;
    ledger.retire('other', 'other-successor');

    expect(ledger.successorFor(PLACEHOLDER)).toBe(CANONICAL);
  });

  it('treats an unreadable ledger as "not retired", rather than throwing at a turn', () => {
    const { store, db } = storeBoundToPlaceholder();
    store.sessionLedger.rebindBySessionId(PLACEHOLDER, CANONICAL);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const select = vi.spyOn(db, 'select').mockImplementation(() => {
      throw new Error('database is locked');
    });

    // Unknown is the pre-DOR-784 behaviour — a rebind that may be wrong — and
    // it is the better of the two: the alternative is a turn that throws where
    // it used to write a binding.
    expect(store.sessionLedger.successorFor(PLACEHOLDER)).toBeUndefined();
    select.mockRestore();
    warn.mockRestore();
  });

  it('records nothing when the rename touched no room', () => {
    // A rekey is announced for every brand-new session on the machine, and the
    // overwhelming majority have nothing to do with a room. Remembering all of
    // them would fill a bounded map with ids no room will ever mention.
    const { store } = storeBoundToPlaceholder();

    expect(store.sessionLedger.rebindBySessionId('unrelated', 'unrelated-canonical')).toEqual([]);
    expect(store.sessionLedger.successorFor('unrelated')).toBeUndefined();
  });
});

describe('the repair sweep', () => {
  /** Ana on claude-code, with `hasTranscript` answering from a fixed set. */
  function sweepDeps(
    store: RoomStore,
    withTranscripts: string[]
  ): RoomBindingRepairDeps & { probed: string[] } {
    const probed: string[] = [];
    return {
      store,
      probed,
      agentPathFor: (authorId) => (authorId === ANA ? ANA_PATH : null),
      hasTranscript: (_agentPath, sessionId) => {
        probed.push(sessionId);
        return Promise.resolve(withTranscripts.includes(sessionId));
      },
    };
  }

  beforeEach(() => {
    // `resolveRoomRuntimeType` reads the agent's manifest and the process
    // registry; with neither present it answers with the registry default, which
    // is claude-code. That is exactly the shape a real install has.
    vi.restoreAllMocks();
  });

  it('repairs a dead binding when the rename is one this process watched', async () => {
    const { store, db } = storeBoundToPlaceholder();
    // The rename happened, so the binding is canonical and the placeholder is
    // known-retired — then something wrote the placeholder back (a pre-fix row,
    // or a restore from a backup).
    store.sessionLedger.rebindBySessionId(PLACEHOLDER, CANONICAL);
    db.update(roomSessions).set({ sessionId: PLACEHOLDER }).run();
    expect(bound(db)).toBe(PLACEHOLDER);

    const report = await repairRoomSessionBindings(sweepDeps(store, [CANONICAL]));

    expect(bound(db)).toBe(CANONICAL);
    expect(report).toEqual({
      checked: 1,
      repaired: 1,
      stranded: 0,
      refused: 0,
      failed: 0,
      unreadable: 0,
    });
  });

  it('repairs a stranding a PREVIOUS process recorded (DOR-1205)', async () => {
    // The boot sweep used to be able to REPORT only, and this is the case it
    // could not touch: the rename happened before the restart, so a per-process
    // memory of retired ids was empty by the time the sweep ran. The whole
    // point of writing retirements down is that this row is repairable now.
    const { store, db } = storeBoundToPlaceholder();
    store.sessionLedger.rebindBySessionId(PLACEHOLDER, CANONICAL);
    db.update(roomSessions).set({ sessionId: PLACEHOLDER }).run();

    const rebooted = new RoomStore(db);
    const report = await repairRoomSessionBindings(sweepDeps(rebooted, [CANONICAL]));

    expect(bound(db)).toBe(CANONICAL);
    expect(report).toEqual({
      checked: 1,
      repaired: 1,
      stranded: 0,
      refused: 0,
      failed: 0,
      unreadable: 0,
    });
  });

  it('never reports a refused write as a repair', async () => {
    // The store refuses a rebind onto an id that is itself retired, and it
    // refuses by doing nothing. Counting that as `repaired` reported a room
    // fixed while it still pointed at the dead id, AND took it out of the
    // stranded count that is the only thing that would tell anyone to look.
    const { store, db } = storeBoundToPlaceholder();
    store.sessionLedger.retire(PLACEHOLDER, CANONICAL);
    store.sessionLedger.retire(CANONICAL, PLACEHOLDER);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const report = await repairRoomSessionBindings(sweepDeps(store, []));

    expect(bound(db)).toBe(PLACEHOLDER);
    expect(report).toEqual({
      checked: 1,
      repaired: 0,
      stranded: 0,
      refused: 1,
      failed: 0,
      unreadable: 0,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('retired too'),
      expect.objectContaining({ roomId: ROOM, deadSessionId: PLACEHOLDER })
    );
    warn.mockRestore();
  });

  it('counts a repair write that threw and keeps sweeping the rest', async () => {
    // The repair write is the only I/O here that can fail after a verdict.
    // Unwrapped, one busy database rejected the whole sweep — no report, and no
    // warning for any binding after it.
    const { store, db } = storeBoundToPlaceholder();
    db.insert(roomSessions)
      .values({ roomId: 'room-frontend', authorId: ANA, sessionId: 'also-dead', createdAt: 'now' })
      .run();
    store.sessionLedger.retire(PLACEHOLDER, CANONICAL);
    vi.spyOn(store, 'rebindRoomSession').mockImplementation(() => {
      throw new Error('database is locked');
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const report = await repairRoomSessionBindings(sweepDeps(store, []));

    // Two bindings judged: the failed repair, and the one behind it that would
    // have gone unexamined if the throw had escaped.
    expect(report).toEqual({
      checked: 2,
      repaired: 0,
      stranded: 1,
      refused: 0,
      failed: 1,
      unreadable: 0,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not write the repair'),
      expect.objectContaining({ roomId: ROOM, error: 'database is locked' })
    );
    warn.mockRestore();
  });

  it('keeps a dead binding with no known successor, and warns with room, agent and id', async () => {
    const { store, db } = storeBoundToPlaceholder();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const report = await repairRoomSessionBindings(sweepDeps(store, []));

    // NOT deleted. A binding pointing nowhere is a conversation somebody may
    // still find by hand; a deleted one is a decision nobody can review.
    expect(bound(db)).toBe(PLACEHOLDER);
    expect(report).toEqual({
      checked: 1,
      repaired: 0,
      stranded: 1,
      refused: 0,
      failed: 0,
      unreadable: 0,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no transcript'),
      expect.objectContaining({ roomId: ROOM, authorId: ANA, agentPath: ANA_PATH })
    );
    warn.mockRestore();
  });

  it('says nothing about a binding whose transcript is on disk', async () => {
    const { store, db } = storeBoundToPlaceholder();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const report = await repairRoomSessionBindings(sweepDeps(store, [PLACEHOLDER]));

    expect(bound(db)).toBe(PLACEHOLDER);
    expect(report).toEqual({
      checked: 1,
      repaired: 0,
      stranded: 0,
      refused: 0,
      failed: 0,
      unreadable: 0,
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never probes a binding whose author is not an agent this install knows', async () => {
    const { store } = storeBoundToPlaceholder();
    const deps = sweepDeps(store, []);
    deps.agentPathFor = () => null;

    const report = await repairRoomSessionBindings(deps);

    expect(deps.probed).toEqual([]);
    expect(report).toEqual({
      checked: 0,
      repaired: 0,
      stranded: 0,
      refused: 0,
      failed: 0,
      unreadable: 0,
    });
  });

  it('reports nothing rather than throwing when the bindings cannot be read', async () => {
    const { store } = storeBoundToPlaceholder();
    vi.spyOn(store.sessionLedger, 'list').mockImplementation(() => {
      throw new Error('database is locked');
    });

    await expect(repairRoomSessionBindings(sweepDeps(store, []))).resolves.toEqual({
      checked: 0,
      repaired: 0,
      stranded: 0,
      refused: 0,
      failed: 0,
      unreadable: 0,
    });
  });

  it('counts a probe it could not run, instead of reporting a clean sweep', async () => {
    // One unreadable `~/.claude/projects` — a permissions change, a mount that
    // did not come back — makes every probe throw. Counting the failures apart
    // from the verdicts is the difference between "nothing is wrong" and
    // "nothing is known", and the second one is what is true.
    const { store } = storeBoundToPlaceholder();
    const deps = sweepDeps(store, []);
    deps.hasTranscript = () => Promise.reject(new Error('EACCES'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const report = await repairRoomSessionBindings(deps);

    expect(report).toEqual({
      checked: 0,
      repaired: 0,
      stranded: 0,
      refused: 0,
      failed: 0,
      unreadable: 1,
    });
    // And it must not do it quietly: a sweep that reached no verdict at all
    // reads exactly like a clean bill of health unless it says otherwise.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('checked 0 of 1 room bindings'),
      expect.objectContaining({ unreadable: 1 })
    );
    warn.mockRestore();
  });

  it('stays quiet when every binding it could not judge sits beside one it could', async () => {
    // The warn is about a sweep with NO verdict. A single unreadable row among
    // readable ones is in the report and does not deserve a line of its own —
    // that would be a warning on every startup with one odd agent on it.
    const { store, db } = storeBoundToPlaceholder();
    db.insert(roomSessions)
      .values({ roomId: 'room-frontend', authorId: ANA, sessionId: 'live', createdAt: 'now' })
      .run();
    const deps = sweepDeps(store, ['live']);
    const probe = deps.hasTranscript;
    deps.hasTranscript = (agentPath, sessionId) =>
      sessionId === PLACEHOLDER ? Promise.reject(new Error('EACCES')) : probe(agentPath, sessionId);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const report = await repairRoomSessionBindings(deps);

    expect(report).toEqual({
      checked: 1,
      repaired: 0,
      stranded: 0,
      refused: 0,
      failed: 0,
      unreadable: 1,
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
