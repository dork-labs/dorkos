/**
 * `POST /api/rooms/:id/entries/:entryId/reactions` and what a reaction does to
 * the room's SSE stream, driven through the REAL app mount.
 *
 * Two things are under test that a service-level test cannot reach. WHO a
 * reaction belongs to — an agent presenting a real identity token leaves a pill
 * in its OWN name (ADR 260814-195522, which reverses etiquette E16b's ban) —
 * because that only means anything against the identity middleware that ships.
 * And the stream's resume contract:
 * a reader that comes back with a `Last-Event-ID` has to end up with the right
 * pills, including on messages BELOW its cursor, which is the one case an entry
 * replay structurally cannot carry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { parseFrames, type SseFrame } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {},
}));

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(),
    get: vi.fn(),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    has: vi.fn(() => true),
    listRuntimes: vi.fn(() => []),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {},
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import { createApp, finalizeApp } from '../../app.js';
import { STREAM_EPOCH } from '../../lib/stream-cursor.js';
import { createRoomSubsystem, setRoomService } from '../../services/rooms/index.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';

const app = createApp();
finalizeApp(app);

const ANA_PATH = '/agents/ana';

/** Register an agent so the room can resolve it by directory. */
function registerAgent(db: Db, name: string, projectPath: string): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: `ULID_${name.toUpperCase()}`,
      name,
      displayName: name[0].toUpperCase() + name.slice(1),
      runtime: 'claude-code',
      projectPath,
      behaviorJson: '{"responseMode":"silent"}',
      registeredAt: now,
      updatedAt: now,
    })
    .run();
}

/** Start the app on an ephemeral port for one test. */
async function listen(): Promise<{ port: number; close: () => void }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return { port: (server.address() as AddressInfo).port, close: () => server.close() };
}

/** Open the room stream and collect frames until `until` is satisfied. */
function openRoomStream(
  port: number,
  roomId: string,
  opts: { until: (frames: SseFrame[]) => boolean; lastEventId?: string }
): { ready: Promise<void>; frames: Promise<SseFrame[]> } {
  let signalReady = (): void => {};
  let resolveFrames: (frames: SseFrame[]) => void = () => {};
  let rejectFrames: (err: unknown) => void = () => {};
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const frames = new Promise<SseFrame[]>((resolve, reject) => {
    resolveFrames = resolve;
    rejectFrames = reject;
  });

  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: `/api/rooms/${roomId}/events`,
      method: 'GET',
      headers: opts.lastEventId !== undefined ? { 'Last-Event-ID': opts.lastEventId } : {},
    },
    (res) => {
      let raw = '';
      let settled = false;
      res.setEncoding('utf8');
      const finish = (): void => {
        if (settled) return;
        settled = true;
        req.destroy();
        resolveFrames(parseFrames(raw));
      };
      res.on('data', (chunk: string) => {
        raw += chunk;
        signalReady();
        if (opts.until(parseFrames(raw))) finish();
      });
      res.on('end', finish);
    }
  );
  req.on('error', rejectFrames);
  req.end();
  return { ready, frames };
}

describe('POST /api/rooms/:id/entries/:entryId/reactions', () => {
  let db: Db;
  let roomId: string;
  let entryId: string;
  let entrySeq: number;
  /** Ana's author id — who a pill she left belongs to. */
  let anaAuthorId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetAgentIdentityService();
    db = createTestDb();
    registerAgent(db, 'ana', ANA_PATH);
    const subsystem = createRoomSubsystem({ db });
    setRoomService(subsystem.service);
    anaAuthorId = subsystem.authors.resolveAgent(ANA_PATH, 'Ana').id;
    const created = await request(app)
      .post('/api/rooms')
      .send({ kind: 'channel', title: 'Backend', agentPaths: [ANA_PATH] });
    roomId = created.body.id;
    const posted = await request(app)
      .post(`/api/rooms/${roomId}/entries`)
      .send({ text: 'Deployed to staging.' });
    entryId = posted.body.entryId;
    entrySeq = posted.body.seq;
  });

  afterEach(() => {
    resetAgentIdentityService();
  });

  /** React as the person at the keyboard. */
  function react(emoji: string, target = entryId) {
    return request(app).post(`/api/rooms/${roomId}/entries/${target}/reactions`).send({ emoji });
  }

  it('accepts with 202 and says which way the toggle went', async () => {
    const added = await react('👍');
    expect(added.status).toBe(202);
    expect(added.body).toMatchObject({ accepted: true, entryId, emoji: '👍', reacted: true });

    const removed = await react('👍');
    expect(removed.status).toBe(202);
    expect(removed.body.reacted, 'the same emoji again takes it back').toBe(false);
  });

  it('is safe to send twice when the body names a state', async () => {
    // The retry a bare toggle cannot survive: a client that times out and
    // re-sends a flip undoes the thing it just did. Naming the state is the
    // shape it should send instead.
    const first = await request(app)
      .post(`/api/rooms/${roomId}/entries/${entryId}/reactions`)
      .send({ emoji: '👍', on: true });
    const retry = await request(app)
      .post(`/api/rooms/${roomId}/entries/${entryId}/reactions`)
      .send({ emoji: '👍', on: true });

    expect([first.status, retry.status]).toEqual([202, 202]);
    expect([first.body.reacted, retry.body.reacted]).toEqual([true, true]);
    const page = await request(app).get(`/api/rooms/${roomId}/entries`);
    expect(page.body.entries[0].reactions.map((pill: { emoji: string }) => pill.emoji)).toEqual([
      '👍',
    ]);
  });

  it('takes a reaction away idempotently when the body says so', async () => {
    await react('👍');
    for (const _ of [1, 2]) {
      const res = await request(app)
        .post(`/api/rooms/${roomId}/entries/${entryId}/reactions`)
        .send({ emoji: '👍', on: false });
      expect(res.status).toBe(202);
      expect(res.body.reacted).toBe(false);
    }
    const page = await request(app).get(`/api/rooms/${roomId}/entries`);
    expect(page.body.entries[0].reactions).toEqual([]);
  });

  it('still flips when the body names no state, which is what a click means', async () => {
    const on = await react('👍');
    const off = await react('👍');
    expect([on.body.reacted, off.body.reacted]).toEqual([true, false]);
  });

  it('refuses an `on` that is not a boolean', async () => {
    const res = await request(app)
      .post(`/api/rooms/${roomId}/entries/${entryId}/reactions`)
      .send({ emoji: '👍', on: 'yes' });
    expect(res.status).toBe(400);
  });

  it('returns the quick row, recomputed with this reaction counted', async () => {
    const res = await react('🔥');
    expect(res.body.frequents).toEqual(['🔥', '👍', '❤️']);
  });

  it('refuses anything that is not a single emoji', async () => {
    for (const emoji of ['lol', '', 'a', '<script>', '👍 nice', 'x'.repeat(200)]) {
      const res = await react(emoji);
      expect(res.status, `"${emoji}" is not a reaction`).toBe(400);
    }
  });

  it('accepts the emoji people actually send, byte for byte', async () => {
    const sent = ['👍', '❤️', '🎉', '🏳️‍🌈', '👍🏽', '🇺🇸', '1️⃣'];
    for (const emoji of sent) {
      const res = await react(emoji);
      expect(res.status, emoji).toBe(202);
      expect(res.body.emoji).toBe(emoji);
    }

    const page = await request(app).get(`/api/rooms/${roomId}/entries`);
    const stored = page.body.entries[0].reactions.map((pill: { emoji: string }) => pill.emoji);
    // Compared as a set. Seven reactions from one person land inside the same
    // millisecond, and a same-millisecond group is ordered by the emoji itself
    // (`ReactionStore.listFor` says why) — so asserting the order they were sent
    // in would be asserting a clock resolution rather than the round trip.
    expect([...stored].sort()).toEqual([...sent].sort());
  });

  it('accepts an agent presenting a real identity token, as itself', async () => {
    // This route used to answer `403 PEOPLE_ONLY` here. ADR 260814-195522
    // reverses etiquette E16b: an agent may react, bounded by an hourly ceiling
    // per room rather than by what kind of author it is. The pill it leaves
    // carries the AGENT's author id, which is the half worth pinning — the token
    // decides who reacted, and nothing in the body can.
    const identity = initAgentIdentityService(db);
    const token = await identity.mint({ agentPath: ANA_PATH, displayName: 'Ana' });

    const res = await request(app)
      .post(`/api/rooms/${roomId}/entries/${entryId}/reactions`)
      .set('X-DorkOS-Agent', token)
      .send({ emoji: '👍' });

    expect(res.status).toBe(202);

    const page = await request(app).get(`/api/rooms/${roomId}/entries`);
    const pills = page.body.entries[0].reactions as Array<{
      emoji: string;
      authorIds: string[];
    }>;
    expect(pills).toHaveLength(1);
    expect(pills[0]!.emoji).toBe('👍');
    expect(pills[0]!.authorIds, 'the pill is the agent"s, not the operator"s').toEqual([
      anaAuthorId,
    ]);
  });

  it('lets that same agent post too', async () => {
    const identity = initAgentIdentityService(db);
    const token = await identity.mint({ agentPath: ANA_PATH, displayName: 'Ana' });

    const res = await request(app)
      .post(`/api/rooms/${roomId}/entries`)
      .set('X-DorkOS-Agent', token)
      .send({ text: 'on it' });

    expect(res.status).toBe(202);
  });

  it('404s an entry that is not in this room', async () => {
    const res = await react('👍', 'no-such-entry');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ENTRY_NOT_FOUND');
  });

  it('404s an unknown room', async () => {
    const res = await request(app)
      .post(`/api/rooms/nope/entries/${entryId}/reactions`)
      .send({ emoji: '👍' });
    expect(res.status).toBe(404);
  });

  it('409s an archived room', async () => {
    await request(app).patch(`/api/rooms/${roomId}`).send({ archived: true });
    const res = await react('👍');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROOM_ARCHIVED');
  });

  it('is in the OpenAPI export the app serves', async () => {
    const spec = await request(app).get('/api/openapi.json');
    const path = spec.body.paths['/api/rooms/{id}/entries/{entryId}/reactions'];
    expect(path?.post).toBeDefined();
    expect(path.post.tags).toEqual(['Rooms']);
    expect(Object.keys(path.post.responses).sort()).toEqual(['202', '400', '403', '404', '409']);
    expect(
      path.post.description,
      'the refusal a client will actually hit has to be documented, not only returned'
    ).toContain('PEOPLE_ONLY');
  });

  describe('on the room stream', () => {
    it('reaches a live reader as the entry’s whole current set', async () => {
      const server = await listen();
      const stream = openRoomStream(server.port, roomId, {
        until: (frames) => frames.some((f) => f.event === 'reaction'),
      });
      await stream.ready;
      await react('👍');
      const frames = await stream.frames;
      server.close();

      const reaction = frames.find((f) => f.event === 'reaction')?.data as {
        entryId: string;
        reactions: Array<{ emoji: string; authorIds: string[] }>;
      };
      expect(reaction.entryId).toBe(entryId);
      expect(reaction.reactions.map((pill) => pill.emoji)).toEqual(['👍']);
    });

    it('hydrates a cold connect with pills already on the entries', async () => {
      await react('🎉');

      const server = await listen();
      const stream = openRoomStream(server.port, roomId, {
        until: (frames) => frames.some((f) => f.event === 'snapshot'),
      });
      const frames = await stream.frames;
      server.close();

      const snapshot = frames.find((f) => f.event === 'snapshot')?.data as {
        entries: Array<{ id: string; reactions: Array<{ emoji: string }> }>;
        room: { reactionFrequents: string[] };
      };
      expect(snapshot.entries.find((entry) => entry.id === entryId)?.reactions).toEqual([
        { emoji: '🎉', authorIds: [expect.any(String)], firstAt: expect.any(String) },
      ]);
      expect(
        snapshot.room.reactionFrequents,
        'the capsule’s quick row rides the room, so it never draws empty'
      ).toEqual(['🎉', '👍', '❤️']);
    });

    /**
     * The reaction state a resumed reader ends up holding, per entry.
     *
     * The stop predicate waits for the LAST entry in the window rather than for
     * "any reaction frame" — the resync walks the window oldest-first, so
     * stopping at the first frame would cut the stream off mid-resync and make
     * every count below a statement about the predicate instead of about the
     * server.
     *
     * @param lastEventId - The cursor the reader comes back with.
     * @param windowTail - The entry id that ends the window, so the collector
     *   knows the resync is complete.
     */
    async function resumeAndCollect(
      lastEventId: string,
      windowTail: string
    ): Promise<{ frames: SseFrame[]; reactionsByEntry: Map<string, Array<{ emoji: string }>> }> {
      const server = await listen();
      const stream = openRoomStream(server.port, roomId, {
        lastEventId,
        until: (frames) =>
          frames.some(
            (f) => f.event === 'reaction' && (f.data as { entryId: string }).entryId === windowTail
          ),
      });
      const frames = await stream.frames;
      server.close();
      const reactionsByEntry = new Map<string, Array<{ emoji: string }>>();
      for (const frame of frames) {
        if (frame.event !== 'reaction') continue;
        const data = frame.data as { entryId: string; reactions: Array<{ emoji: string }> };
        reactionsByEntry.set(data.entryId, data.reactions);
      }
      return { frames, reactionsByEntry };
    }

    it('resyncs a reaction that landed BELOW the resume cursor while the reader was away', async () => {
      // The reader holds through `entrySeq`. A second entry arrives, and the
      // reaction lands on the OLD one — so the replay (`seq > cursor`) carries
      // exactly one entry and says nothing about the pill the reader is missing.
      const later = await request(app)
        .post(`/api/rooms/${roomId}/entries`)
        .send({ text: 'and the rollback plan?' });
      await react('👍');

      const { frames, reactionsByEntry } = await resumeAndCollect(
        `${roomId}-${STREAM_EPOCH}-${entrySeq}`,
        later.body.entryId
      );

      expect(
        frames.some((f) => f.event === 'snapshot'),
        'a resume skips the snapshot; the resync is what makes that safe'
      ).toBe(false);
      const replayed = frames.filter((f) => f.event === 'entry');
      expect(replayed).toHaveLength(1);
      expect((replayed[0].data as { entry: { id: string } }).entry.id).toBe(later.body.entryId);

      expect(reactionsByEntry.get(entryId)?.map((pill) => pill.emoji)).toEqual(['👍']);
      expect(
        reactionsByEntry.get(later.body.entryId),
        'every entry in the window is reported, pills or not'
      ).toEqual([]);
    });

    it('resyncs a REMOVAL that happened while the reader was away', async () => {
      // The failure this closes: react, disconnect, take it back, resume. The
      // entry is below the cursor and unchanged, so nothing replays it — and if
      // the resync only named entries that still HAVE pills, the reader would sit
      // on a 👍 the server no longer holds, with nothing on the wire to correct it.
      const later = await request(app)
        .post(`/api/rooms/${roomId}/entries`)
        .send({ text: 'and the rollback plan?' });
      await react('👍');
      // …the reader disconnects here, holding that pill…
      await react('👍');

      const { reactionsByEntry } = await resumeAndCollect(
        `${roomId}-${STREAM_EPOCH}-${entrySeq}`,
        later.body.entryId
      );

      expect(
        reactionsByEntry.has(entryId),
        'the resync must mention the entry whose pill went away'
      ).toBe(true);
      expect(reactionsByEntry.get(entryId), 'and say it is empty now').toEqual([]);

      const truth = await request(app).get(`/api/rooms/${roomId}/entries`);
      expect(
        reactionsByEntry.get(entryId),
        'what the resumed reader draws matches what the server holds'
      ).toEqual(truth.body.entries[0].reactions);
    });

    it('gives a reaction frame no id: line, so it can never move the resume cursor', async () => {
      const server = await listen();
      const stream = openRoomStream(server.port, roomId, {
        until: (frames) => frames.some((f) => f.event === 'reaction'),
      });
      await stream.ready;
      await react('👍');
      const frames = await stream.frames;
      server.close();

      expect(frames.find((f) => f.event === 'reaction')?.id).toBeUndefined();
    });
  });
});
