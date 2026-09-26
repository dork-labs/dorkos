/**
 * An agent that leaves your team leaves every channel with it (DOR-2095).
 *
 * Driven over the shipped agent lookup (`createAgentLookup`) and real `agents`
 * rows, like `ghost-authors.test.ts`: the whole mechanism is "does this
 * directory still hold this agent", and a hand-written lookup would only prove
 * itself. An unregister is modelled the way Mesh performs one — the registry row
 * goes, THEN the `onUnregister` callbacks fire — through the real
 * `registerRoomUnregisterCascade`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agents,
  and,
  authors,
  eq,
  roomDepartedSeats,
  roomEntries,
  roomMembers,
  roomSessions,
  rooms,
  type Db,
} from '@dorkos/db';
import { AgentRegistry, MeshCore } from '@dorkos/mesh';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { eventFanOut } from '../../core/event-fan-out.js';
import { createAgentLookup } from '../index.js';
import { RoomTriggerDispatcher } from '../room-trigger.js';
import {
  diskEvidence,
  registerRoomUnregisterCascade,
  sweepDepartedAgentSeats,
  type DepartedAgentEvidence,
} from '../manage/departed-agents.js';
import { createRoomHarness, type RoomHarness } from './room-test-harness.js';

const ANA_PATH = '/agents/ana';
const BO_PATH = '/agents/bo';

/** Register an agent row the way the mesh registry does. */
function registerAgent(
  db: Db,
  input: { id: string; projectPath: string; name: string; status?: 'active' | 'unreachable' }
): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: input.id,
      name: input.name,
      runtime: 'claude-code',
      projectPath: input.projectPath,
      registeredAt: now,
      updatedAt: now,
      ...(input.status ? { status: input.status } : {}),
    })
    .run();
}

type Change = { kind: string; agentId: string; projectPath?: string };

/**
 * A fake Mesh that registers and unregisters the way the real one does: the
 * registry row first, then the callbacks — `onAgentsChanged` with `registered`,
 * or `onUnregister` with the recorded path.
 */
function fakeMesh(db: Db) {
  const unregistered: Array<(agentId: string, projectPath: string) => void> = [];
  const changed: Array<(change: Change) => void> = [];
  return {
    onUnregister(callback: (agentId: string, projectPath: string) => void) {
      unregistered.push(callback);
    },
    onAgentsChanged(callback: (change: Change) => void) {
      changed.push(callback);
    },
    register(agentId: string, projectPath: string, name: string) {
      registerAgent(db, { id: agentId, projectPath, name });
      for (const callback of changed) callback({ kind: 'registered', agentId, projectPath });
    },
    unregister(agentId: string, projectPath: string) {
      db.delete(agents).where(eq(agents.id, agentId)).run();
      for (const callback of unregistered) callback(agentId, projectPath);
    },
  };
}

/** Disk evidence where no directory holds a manifest and nothing is denied. */
function emptyDisk(overrides: Partial<DepartedAgentEvidence> = {}): DepartedAgentEvidence {
  return {
    isDenied: () => false,
    manifestIdAt: async () => null,
    ...overrides,
  };
}

const quiet = { info: () => {} };

function liveHarness(): RoomHarness {
  return createRoomHarness({ agents: (db) => createAgentLookup(db) });
}

function channel(harness: RoomHarness, slug: string, agentPaths: string[]): RoomWithRoster {
  const room = harness.service.createRoom(
    { kind: 'channel', slug, title: `#${slug}`, members: [], agentPaths },
    harness.human
  );
  return harness.service.getRoom(room.id, harness.human)!;
}

function dm(harness: RoomHarness, agentPaths: string[]): RoomWithRoster {
  const room = harness.service.createRoom(
    { kind: 'dm', title: 'DM', members: [], agentPaths },
    harness.human
  );
  return harness.service.getRoom(room.id, harness.human)!;
}

function read(harness: RoomHarness, roomId: string): RoomWithRoster {
  return harness.service.getRoom(roomId, harness.human)!;
}

function memberIds(room: RoomWithRoster): string[] {
  return room.members.map((member) => member.authorId);
}

describe('unregistering an agent cascades into its rooms', () => {
  let events: Array<{ name: string; data: unknown }>;
  let unsubscribe: () => void;

  beforeEach(() => {
    events = [];
    unsubscribe = eventFanOut.subscribe((name, data) => events.push({ name, data }));
  });
  afterEach(() => unsubscribe());

  it('takes the agent off every channel roster and leaves the others alone', () => {
    const harness = liveHarness();
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    registerAgent(harness.db, { id: 'ULID_BO', projectPath: BO_PATH, name: 'bo' });
    const general = channel(harness, 'general', [ANA_PATH, BO_PATH]);
    const random = channel(harness, 'random', [ANA_PATH]);
    const ana = harness.authors.resolveAgent(ANA_PATH, 'ana').id;
    const bo = harness.authors.resolveAgent(BO_PATH, 'bo').id;
    const mesh = fakeMesh(harness.db);
    registerRoomUnregisterCascade(mesh, harness.service, quiet);

    mesh.unregister('ULID_ANA', ANA_PATH);

    expect(memberIds(read(harness, general.id))).not.toContain(ana);
    expect(memberIds(read(harness, general.id))).toContain(bo);
    expect(memberIds(read(harness, random.id))).not.toContain(ana);
    // Every open window hears about each seat, the way a manual removal says it.
    const removals = events.filter((e) => e.name === 'room_member_removed').map((e) => e.data);
    expect(removals).toEqual(
      expect.arrayContaining([
        { roomId: general.id, authorId: ana },
        { roomId: random.id, authorId: ana },
      ])
    );
  });

  it('keeps a direct message whole and draws the agent in it as retired', () => {
    const harness = liveHarness();
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    const direct = dm(harness, [ANA_PATH]);
    const ana = harness.authors.resolveAgent(ANA_PATH, 'ana').id;
    const mesh = fakeMesh(harness.db);
    registerRoomUnregisterCascade(mesh, harness.service, quiet);
    expect(read(harness, direct.id).members.find((m) => m.authorId === ana)?.author.retired).toBe(
      undefined
    );

    mesh.unregister('ULID_ANA', ANA_PATH);

    const after = read(harness, direct.id);
    const member = after.members.find((m) => m.authorId === ana);
    // Still there — a DM is named by who is in it — but inactive: retired, and
    // answering to no `@`.
    expect(member?.author.retired).toBe(true);
    expect(member?.author.handle).toBeNull();
    expect(events).toContainEqual({ name: 'room_updated', data: { roomId: direct.id } });
  });

  it("keeps the agent's messages, with its name, as a retired former author", () => {
    const harness = liveHarness();
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    const general = channel(harness, 'general', [ANA_PATH]);
    const ana = harness.authors.resolveAgent(ANA_PATH, 'Ana');
    const said = harness.service.post(general.id, { authorId: ana.id, text: 'shipped it' });
    const mesh = fakeMesh(harness.db);
    registerRoomUnregisterCascade(mesh, harness.service, quiet);
    expect(read(harness, general.id).formerAuthors).toEqual([]);

    mesh.unregister('ULID_ANA', ANA_PATH);

    const after = read(harness, general.id);
    const entries = harness.service.listEntries(general.id, harness.human, { limit: 50 });
    expect(entries.find((entry) => entry.id === said.id)?.authorId).toBe(ana.id);
    expect(after.formerAuthors).toEqual([
      {
        author: expect.objectContaining({
          id: ana.id,
          displayName: 'Ana',
          handle: null,
          retired: true,
        }),
        origin: 'local',
      },
    ]);
  });

  it('names a member who was only taken out of the room without calling them retired', () => {
    const harness = liveHarness();
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    const general = channel(harness, 'general', [ANA_PATH]);
    const ana = harness.authors.resolveAgent(ANA_PATH, 'Ana');
    harness.service.post(general.id, { authorId: ana.id, text: 'hello' });

    harness.service.removeMember(general.id, harness.human, ana.id);

    const former = read(harness, general.id).formerAuthors ?? [];
    expect(former.map((f) => f.author.id)).toEqual([ana.id]);
    expect(former[0]?.author.retired).toBeUndefined();
  });

  it('clears the fallback seat the agent held', () => {
    const harness = liveHarness();
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    const general = channel(harness, 'general', [ANA_PATH]);
    const ana = harness.authors.resolveAgent(ANA_PATH, 'ana').id;
    harness.service.setFallbackSeat(general.id, harness.human, ana);
    const mesh = fakeMesh(harness.db);
    registerRoomUnregisterCascade(mesh, harness.service, quiet);

    mesh.unregister('ULID_ANA', ANA_PATH);

    expect(read(harness, general.id).fallbackSeatAuthorId ?? null).toBeNull();
  });

  it('takes nobody out while the directory still holds a registered agent', () => {
    const harness = liveHarness();
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    const general = channel(harness, 'general', [ANA_PATH]);
    const ana = harness.authors.resolveAgent(ANA_PATH, 'ana').id;

    // A cascade that arrives for a directory whose agent is still registered —
    // a stale callback, or a re-register that won the race — moves nothing.
    const result = harness.service.dropDepartedAgentAt(ANA_PATH, 'ULID_ANA');

    expect(result.removed).toEqual([]);
    expect(memberIds(read(harness, general.id))).toContain(ana);
  });

  it('takes the session binding with the seat', () => {
    const harness = liveHarness();
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    const general = channel(harness, 'general', [ANA_PATH]);
    const ana = harness.authors.resolveAgent(ANA_PATH, 'ana').id;
    harness.db
      .insert(roomSessions)
      .values({
        roomId: general.id,
        authorId: ana,
        sessionId: 'session-ana',
        createdAt: new Date().toISOString(),
      })
      .run();
    const mesh = fakeMesh(harness.db);
    registerRoomUnregisterCascade(mesh, harness.service, quiet);

    mesh.unregister('ULID_ANA', ANA_PATH);

    expect(
      harness.db.select().from(roomSessions).where(eq(roomSessions.authorId, ana)).all()
    ).toEqual([]);
  });

  it('drops whatever the room was still waiting on from the agent', () => {
    const harness = liveHarness();
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    const general = channel(harness, 'general', [ANA_PATH]);
    const ana = harness.authors.resolveAgent(ANA_PATH, 'ana').id;
    const abandon = vi.spyOn(RoomTriggerDispatcher.prototype, 'abandonHolds');
    const mesh = fakeMesh(harness.db);
    registerRoomUnregisterCascade(mesh, harness.service, quiet);

    mesh.unregister('ULID_ANA', ANA_PATH);

    expect(abandon).toHaveBeenCalledWith(general.id, ana);
  });

  it('never names the room’s own voice as a former author', () => {
    const harness = liveHarness();
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    const general = channel(harness, 'general', [ANA_PATH]);
    const system = harness.authors.system();
    harness.db
      .insert(roomEntries)
      .values({
        roomId: general.id,
        seq: 99,
        id: 'ENTRY_SYSTEM',
        authorId: system.id,
        kind: 'notice',
        body: JSON.stringify({ text: 'the room speaking' }),
        cascadeRoot: 'ENTRY_SYSTEM',
        createdAt: new Date().toISOString(),
      })
      .run();

    expect((read(harness, general.id).formerAuthors ?? []).map((f) => f.author.id)).not.toContain(
      system.id
    );
  });

  it('writes nothing when the seat cannot be recorded — the whole departure rolls back', () => {
    const harness = liveHarness();
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    const general = channel(harness, 'general', [ANA_PATH]);
    const ana = harness.authors.resolveAgent(ANA_PATH, 'ana').id;
    harness.db.$client.exec(
      "CREATE TRIGGER refuse_tombstone BEFORE INSERT ON room_departed_seats BEGIN SELECT RAISE(ABORT, 'refused'); END"
    );
    harness.db.delete(agents).where(eq(agents.id, 'ULID_ANA')).run();

    expect(() => harness.service.dropDepartedAgentAt(ANA_PATH, 'ULID_ANA')).toThrow(/refused/);
    expect(memberIds(read(harness, general.id))).toContain(ana);
  });

  it('leaves a direct message with the agent active again when the same agent returns', () => {
    const harness = liveHarness();
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    const direct = dm(harness, [ANA_PATH]);
    const ana = harness.authors.resolveAgent(ANA_PATH, 'ana').id;
    const mesh = fakeMesh(harness.db);
    registerRoomUnregisterCascade(mesh, harness.service, quiet);
    mesh.unregister('ULID_ANA', ANA_PATH);

    mesh.register('ULID_ANA', ANA_PATH, 'ana');

    const member = read(harness, direct.id).members.find((m) => m.authorId === ana);
    expect(member?.author.retired).toBeUndefined();
    expect(member?.author.handle).toBe('ana');
  });

  it('leaves a different agent registered at the same directory with nothing inherited', () => {
    const harness = liveHarness();
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    const general = channel(harness, 'general', [ANA_PATH]);
    const direct = dm(harness, [ANA_PATH]);
    const oldAna = harness.authors.resolveAgent(ANA_PATH, 'ana').id;
    const mesh = fakeMesh(harness.db);
    registerRoomUnregisterCascade(mesh, harness.service, quiet);
    mesh.unregister('ULID_ANA', ANA_PATH);

    mesh.register('ULID_NEW', ANA_PATH, 'ana');
    const fresh = harness.authors.resolveAgent(ANA_PATH, 'ana').id;

    expect(fresh).not.toBe(oldAna);
    expect(
      read(harness, direct.id).members.find((m) => m.authorId === oldAna)?.author.retired
    ).toBe(true);
    // Neither the old author nor the new one is back in the channel.
    expect(memberIds(read(harness, general.id))).not.toContain(oldAna);
    expect(memberIds(read(harness, general.id))).not.toContain(fresh);
  });
});

describe('an agent that comes back gets its channels back', () => {
  let events: Array<{ name: string; data: unknown }>;
  let unsubscribe: () => void;

  beforeEach(() => {
    events = [];
    unsubscribe = eventFanOut.subscribe((name, data) => events.push({ name, data }));
  });
  afterEach(() => unsubscribe());

  /** Ana, seated and tuned in #general, then unregistered. */
  function departed() {
    const harness = liveHarness();
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    const general = channel(harness, 'general', [ANA_PATH]);
    const ana = harness.authors.resolveAgent(ANA_PATH, 'ana').id;
    harness.service.updateMembership(general.id, harness.human, ana, 'mention-only');
    harness.service.setFallbackSeat(general.id, harness.human, ana);
    harness.db
      .update(roomMembers)
      .set({ lastReadSeq: 7 })
      .where(and(eq(roomMembers.roomId, general.id), eq(roomMembers.authorId, ana)))
      .run();
    const mesh = fakeMesh(harness.db);
    registerRoomUnregisterCascade(mesh, harness.service, quiet);
    mesh.unregister('ULID_ANA', ANA_PATH);
    expect(memberIds(read(harness, general.id))).not.toContain(ana);
    return { harness, general, ana, mesh };
  }

  it('gives the seat back with its settings, its read position and its fallback seat', () => {
    const { harness, general, ana, mesh } = departed();

    mesh.register('ULID_ANA', ANA_PATH, 'ana');

    const room = read(harness, general.id);
    const seat = room.members.find((m) => m.authorId === ana);
    expect(seat).toMatchObject({ responseMode: 'mention-only', lastReadSeq: 7 });
    expect(room.fallbackSeatAuthorId).toBe(ana);
    expect(events).toContainEqual({
      name: 'room_member_added',
      data: { roomId: general.id, authorId: ana },
    });
  });

  it('gives nothing back twice', () => {
    const { harness, general, ana, mesh } = departed();
    mesh.register('ULID_ANA', ANA_PATH, 'ana');
    harness.service.removeMember(general.id, harness.human, ana);

    // A second registration signal for the same agent replays nothing: the
    // tombstone went with the first replay, and a seat the person has since
    // taken away again stays taken away.
    expect(harness.service.restoreReturningAgentAt(ANA_PATH)).toEqual([]);
    expect(memberIds(read(harness, general.id))).not.toContain(ana);
  });

  it('gives nothing back in a room that is gone or archived', () => {
    const harness = liveHarness();
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    const gone = channel(harness, 'gone', [ANA_PATH]);
    const shelved = channel(harness, 'shelved', [ANA_PATH]);
    const ana = harness.authors.resolveAgent(ANA_PATH, 'ana').id;
    const mesh = fakeMesh(harness.db);
    registerRoomUnregisterCascade(mesh, harness.service, quiet);
    mesh.unregister('ULID_ANA', ANA_PATH);
    harness.db.delete(rooms).where(eq(rooms.id, gone.id)).run();
    harness.db.update(rooms).set({ archived: true }).where(eq(rooms.id, shelved.id)).run();

    mesh.register('ULID_ANA', ANA_PATH, 'ana');

    expect(
      harness.db.select().from(roomMembers).where(eq(roomMembers.authorId, ana)).all()
    ).toEqual([]);
    // Nothing is left waiting for a room that cannot take it.
    expect(harness.db.select().from(roomDepartedSeats).all()).toEqual([]);
  });

  it('keeps the seat somebody holds now, rather than overwriting it', () => {
    const { harness, general, ana, mesh } = departed();
    // Somebody else took the fallback seat while Ana was away.
    registerAgent(harness.db, { id: 'ULID_BO', projectPath: BO_PATH, name: 'bo' });
    harness.service.addMember(general.id, harness.human, { agentPath: BO_PATH });
    const bo = harness.authors.resolveAgent(BO_PATH, 'bo').id;
    harness.service.setFallbackSeat(general.id, harness.human, bo);

    mesh.register('ULID_ANA', ANA_PATH, 'ana');

    const room = read(harness, general.id);
    expect(memberIds(room)).toContain(ana);
    expect(room.fallbackSeatAuthorId).toBe(bo);
  });

  it('gives back nothing to a different agent at the same folder', () => {
    const { harness, general, mesh } = departed();

    mesh.register('ULID_SOMEONE_ELSE', ANA_PATH, 'ana');

    expect(harness.service.restoreReturningAgentAt(ANA_PATH)).toEqual([]);
    expect(read(harness, general.id).members.filter((m) => m.author.kind === 'agent')).toEqual([]);
  });

  it('gives nothing back to a different agent, even through an author that never carried a stamp', () => {
    const harness = liveHarness();
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    const general = channel(harness, 'general', [ANA_PATH]);
    const ana = harness.authors.resolveAgent(ANA_PATH, 'ana').id;
    // A row minted before occupancy stamps existed: "live" for whoever is there.
    harness.db.update(authors).set({ mintedForManifestId: null }).where(eq(authors.id, ana)).run();
    const mesh = fakeMesh(harness.db);
    registerRoomUnregisterCascade(mesh, harness.service, quiet);
    mesh.unregister('ULID_ANA', ANA_PATH);

    mesh.register('ULID_SOMEONE_ELSE', ANA_PATH, 'ana');

    expect(memberIds(read(harness, general.id))).not.toContain(ana);
  });

  it('writes nothing when the return cannot be recorded — the whole replay rolls back', () => {
    const { harness, general, ana } = departed();
    harness.db.$client.exec(
      "CREATE TRIGGER refuse_forget BEFORE DELETE ON room_departed_seats BEGIN SELECT RAISE(ABORT, 'refused'); END"
    );
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });

    expect(() => harness.service.restoreReturningAgentAt(ANA_PATH)).toThrow(/refused/);
    expect(memberIds(read(harness, general.id))).not.toContain(ana);
    expect(harness.db.select().from(roomDepartedSeats).all()).toHaveLength(1);
  });

  it('gives seats back at boot to an agent that returned while nothing was listening', async () => {
    const { harness, general, ana } = departed();
    // Registered with no hook to hear it — a return during a restart.
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });

    const result = await sweepDepartedAgentSeats({
      rooms: harness.service,
      evidence: emptyDisk(),
      logger: quiet,
    });

    expect(result.restored).toBe(1);
    expect(memberIds(read(harness, general.id))).toContain(ana);
  });
});

describe('the weekend away, end to end through the real Mesh', () => {
  it('unregisters an agent unreachable past the grace period, and seats it again when it returns', async () => {
    const harness = liveHarness();
    const root = await realpath(await mkdtemp(join(tmpdir(), 'weekend-')));
    try {
      const mesh = new MeshCore({ db: harness.db, defaultScanRoot: root });
      registerRoomUnregisterCascade(mesh, harness.service, quiet);
      const dee = join(root, 'dee');
      await mkdir(dee, { recursive: true });
      const manifest = await mesh.registerByPath(dee, { name: 'dee', runtime: 'claude-code' });
      const weekend = channel(harness, 'weekend', [dee]);
      const author = harness.authors.resolveAgent(dee, 'dee').id;
      harness.service.updateMembership(weekend.id, harness.human, author, 'mention-only');

      // The drive goes away — out of every root the reconciler walks — and
      // stays away past the 24-hour grace.
      const away = await realpath(await mkdtemp(join(tmpdir(), 'weekend-away-')));
      await rename(dee, join(away, 'dee'));
      new AgentRegistry(harness.db).markUnreachable(manifest.id);
      harness.db
        .update(agents)
        .set({ updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() })
        .where(eq(agents.id, manifest.id))
        .run();
      const swept = await mesh.reconcileOnStartup();
      expect(swept.removed).toBe(1);
      expect(memberIds(read(harness, weekend.id))).not.toContain(author);

      // Monday: the drive is back, with the same manifest, and a scan finds it.
      await rename(join(away, 'dee'), dee);
      await rm(away, { recursive: true, force: true });
      expect(await mesh.syncFromDisk(dee)).toBe('synced');

      const seat = read(harness, weekend.id).members.find((m) => m.authorId === author);
      expect(seat).toMatchObject({ responseMode: 'mention-only' });
      expect(seat?.author.retired).toBeUndefined();
      mesh.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('the repair sweep for seats left behind', () => {
  /**
   * A ghost as the world has them today: an agent unregistered before the
   * cascade existed, so its registry row is gone and its seats are not.
   */
  function withGhost(harness: RoomHarness) {
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    registerAgent(harness.db, { id: 'ULID_BO', projectPath: BO_PATH, name: 'bo' });
    const general = channel(harness, 'general', [ANA_PATH, BO_PATH]);
    const direct = dm(harness, [ANA_PATH]);
    const ana = harness.authors.resolveAgent(ANA_PATH, 'ana').id;
    const bo = harness.authors.resolveAgent(BO_PATH, 'bo').id;
    harness.db.delete(agents).where(eq(agents.projectPath, ANA_PATH)).run();
    return { general, direct, ana, bo };
  }

  it('removes a ghost from every channel, keeps its DM, and does it once', async () => {
    const harness = liveHarness();
    const { general, direct, ana, bo } = withGhost(harness);

    const first = await sweepDepartedAgentSeats({
      rooms: harness.service,
      evidence: emptyDisk(),
      logger: quiet,
    });
    expect(first).toEqual({ removed: 1, pending: 0, restored: 0 });
    expect(memberIds(read(harness, general.id))).toEqual(expect.not.arrayContaining([ana]));
    expect(memberIds(read(harness, general.id))).toContain(bo);
    expect(memberIds(read(harness, direct.id))).toContain(ana);

    // Idempotent: nothing left to do the second time.
    const second = await sweepDepartedAgentSeats({
      rooms: harness.service,
      evidence: emptyDisk(),
      logger: quiet,
    });
    expect(second).toEqual({ removed: 0, pending: 0, restored: 0 });
  });

  it('never touches an agent that is registered but unreachable', async () => {
    const harness = liveHarness();
    registerAgent(harness.db, {
      id: 'ULID_ANA',
      projectPath: ANA_PATH,
      name: 'ana',
      status: 'unreachable',
    });
    const general = channel(harness, 'general', [ANA_PATH]);
    const ana = harness.authors.resolveAgent(ANA_PATH, 'ana').id;

    const result = await sweepDepartedAgentSeats({
      rooms: harness.service,
      evidence: emptyDisk(),
      logger: quiet,
    });

    expect(result).toEqual({ removed: 0, pending: 0, restored: 0 });
    expect(memberIds(read(harness, general.id))).toContain(ana);
  });

  it('keeps the seats of an agent whose own manifest is on disk, waiting to be registered', async () => {
    const harness = liveHarness();
    const { general, ana } = withGhost(harness);

    const result = await sweepDepartedAgentSeats({
      rooms: harness.service,
      evidence: emptyDisk({ manifestIdAt: async () => 'ULID_ANA' }),
      logger: quiet,
    });

    expect(result).toEqual({ removed: 0, pending: 1, restored: 0 });
    expect(memberIds(read(harness, general.id))).toContain(ana);
  });

  it('removes a ghost whose directory now holds a DIFFERENT agent’s manifest', async () => {
    const harness = liveHarness();
    const { general, ana } = withGhost(harness);

    const result = await sweepDepartedAgentSeats({
      rooms: harness.service,
      evidence: emptyDisk({ manifestIdAt: async () => 'ULID_SOMEBODY_ELSE' }),
      logger: quiet,
    });

    expect(result.removed).toBe(1);
    expect(memberIds(read(harness, general.id))).not.toContain(ana);
  });

  it('removes a ghost whose manifest stayed only because its directory was denied', async () => {
    const harness = liveHarness();
    const { general, ana } = withGhost(harness);

    const result = await sweepDepartedAgentSeats({
      rooms: harness.service,
      evidence: emptyDisk({
        isDenied: (path) => path === ANA_PATH,
        manifestIdAt: async () => 'ULID_ANA',
      }),
      logger: quiet,
    });

    expect(result).toEqual({ removed: 1, pending: 0, restored: 0 });
    expect(memberIds(read(harness, general.id))).not.toContain(ana);
  });

  it('spares an agent registered again while the sweep was reading the disk', async () => {
    const harness = liveHarness();
    const { general, ana } = withGhost(harness);

    const result = await sweepDepartedAgentSeats({
      rooms: harness.service,
      evidence: emptyDisk({
        manifestIdAt: async () => {
          // The reconciler lands the registration mid-sweep.
          registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
          return null;
        },
      }),
      logger: quiet,
    });

    expect(result.removed).toBe(0);
    expect(memberIds(read(harness, general.id))).toContain(ana);
  });
});

describe('the disk evidence the sweep reads', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'departed-')));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the manifest's own id, and null where there is none", async () => {
    const agentPath = join(dir, 'ana');
    await writeManifest(agentPath, {
      id: '01M054RMQAMZPXHWHRKPGY9Z87',
      name: 'ana',
      runtime: 'claude-code',
      capabilities: [],
      behavior: { responseMode: 'always' },
      registeredAt: '2026-09-01T00:00:00.000Z',
      registeredBy: 'test',
    } as unknown as AgentManifest);
    const evidence = diskEvidence(() => []);

    expect(await evidence.manifestIdAt(agentPath)).toBe('01M054RMQAMZPXHWHRKPGY9Z87');
    expect(await evidence.manifestIdAt(join(dir, 'nobody'))).toBeNull();
    expect(await evidence.manifestIdAt('/no/such/drive/agent')).toBeNull();
  });

  it('matches a denied directory as written and through a symlink', async () => {
    const real = join(dir, 'real');
    await writeManifest(real, {
      id: '01M054RMQAMZPXHWHRKPGY9Z88',
      name: 'real',
      runtime: 'claude-code',
      capabilities: [],
      behavior: { responseMode: 'always' },
      registeredAt: '2026-09-01T00:00:00.000Z',
      registeredBy: 'test',
    } as unknown as AgentManifest);
    const link = join(dir, 'link');
    await symlink(real, link);
    // The denial list stores canonical paths.
    const evidence = diskEvidence(() => [{ path: real }]);

    expect(evidence.isDenied(real)).toBe(true);
    expect(evidence.isDenied(link)).toBe(true);
    expect(evidence.isDenied(join(dir, 'other'))).toBe(false);
  });
});
