/**
 * `GET /api/events` numbers its frames and replays from `Last-Event-ID`
 * (ADR 261123-170833), over the real route and the real fan-out.
 *
 * The case that matters most is the filter: a replay must never hand a reader a
 * frame it could not have received live, and rights are asked as each frame
 * goes out, never captured. A cursor gives no rights: one taken from another
 * reader's stream replays only what the resuming reader may read. The tunnel's
 * status is the snapshot's other part.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import eventsRoutes from '../events.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { EVENT_REPLAY_LIMITS } from '../../lib/event-stream/event-replay-buffer.js';
import { frontDoorReadAudience, type CallerPrincipal } from '../../lib/caller-principal.js';
import { tunnelManager } from '../../services/core/tunnel-manager.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import { roomAudience } from '../../services/rooms/service/room-audience.js';

const AGENT = { 'x-dorkos-agent': 'tok_revoked' };
const operatorOnly = (principal: CallerPrincipal): boolean => principal.kind === 'operator';

/** A test-only header naming the user a program's key belongs to; see `asProgram`. */
const PROGRAM_HEADER = 'x-test-program';

/** The headers of a program holding user `userId`'s key, with login off. */
const asProgram = (userId: string): Record<string, string> => ({ [PROGRAM_HEADER]: userId });

/** Who is in room `r1` right now, read by its audience as each frame goes out. */
const members = new Set<string>();
const rooms = {
  authorRegistry: { human: (id: string) => ({ id }) } as Parameters<
    typeof roomAudience
  >[1]['authorRegistry'],
  requireMembership: (_roomId: string, authorId: string) => {
    if (!members.has(authorId)) throw new Error('not a member');
  },
};

let server: http.Server;
let baseUrl: string;
const open: http.ClientRequest[] = [];
let home: string;

// A real config in a throwaway folder: the `/api` chain reads it.
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-events-replay-'));
  initConfigManager(home);
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

beforeEach(async () => {
  members.clear();
  server = http.createServer(
    honoGroupListener(
      { path: '/api/events', routes: eventsRoutes },
      {
        // A key the gate would have verified, as the chain hands it on.
        before: async (c, next) => {
          const userId = c.req.header(PROGRAM_HEADER);
          if (userId) c.set('user', { userId, credential: 'api-key' });
          await next();
        },
      }
    )
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  for (const req of open.splice(0)) req.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Open a stream; `until` is checked on every chunk. */
function stream(
  headers: Record<string, string>,
  path = '/api/events'
): (until: (text: string) => boolean) => Promise<string> {
  let text = '';
  const waiters = new Set<() => void>();
  const req = http.get(`${baseUrl}${path}`, { headers, agent: false }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      text += chunk;
      for (const wake of waiters) wake();
    });
    res.on('error', () => undefined);
  });
  req.on('error', () => undefined);
  open.push(req);
  return (until) =>
    new Promise((resolve) => {
      const check = (): void => {
        if (!until(text)) return;
        waiters.delete(check);
        resolve(text);
      };
      waiters.add(check);
      check();
    });
}

/** Open a stream and resolve with its text once `until` holds. */
function read(
  headers: Record<string, string>,
  until: (text: string) => boolean,
  path?: string
): Promise<string> {
  return stream(headers, path)(until);
}

/** One numbered frame: its cursor, its type, its envelope's place and time, and its payload as JSON. */
interface NumberedFrame {
  id: string;
  event: string;
  seq: number;
  at: string;
  data: string;
}

/**
 * The numbered frames in a body, in order. Each `data:` is a whole envelope
 * whose `type` is the `event:` line and whose `seq` is the cursor's last part.
 */
function numbered(text: string): NumberedFrame[] {
  return [...text.matchAll(/id: (\S+)\nevent: (\S+)\ndata: (.*)\n\n/g)].map(
    ([, id, event, data]) => {
      const envelope = JSON.parse(data!) as {
        seq: number;
        at: string;
        type: string;
        payload: unknown;
      };
      expect(envelope.type).toBe(event);
      expect(id!.endsWith(`-${envelope.seq}`)).toBe(true);
      return {
        id: id!,
        event: event!,
        seq: envelope.seq,
        at: envelope.at,
        data: JSON.stringify(envelope.payload),
      };
    }
  );
}

/** The opening `connected` frame: `seq: null`, no id, its payload as given. */
function connectedFrame(payload: string): RegExp {
  return new RegExp(
    `^event: connected\\ndata: \\{"seq":null,"at":"[^"]+","type":"connected","payload":${payload}\\}\\n\\n`
  );
}

/** Broadcast a marker and return its frame id, read off a live stream. */
async function marker(): Promise<string> {
  const live = stream({});
  await live((text) => text.includes('event: connected'));
  eventFanOut.broadcast('tasks_changed', { marker: true });
  return numbered(await live((text) => text.includes('"marker":true'))).at(-1)!.id;
}

describe('GET /api/events replay', () => {
  it('numbers broadcasts and replays only what came after the cursor, filtered per reader', async () => {
    const cursor = await marker();
    expect(cursor).toMatch(/^events-\d+-g\d+-\d+$/);

    eventFanOut.broadcast('config_changed', { sections: ['spaces'] }, operatorOnly);
    eventFanOut.broadcast('agents_changed', { kind: 'updated', agentId: 'a1' });

    const done = (text: string): boolean => text.includes('event: agents_changed');
    const person = await read({ 'last-event-id': cursor }, done);
    const program = await read({ ...asProgram('u1'), 'last-event-id': cursor }, done);

    expect(person).toMatch(connectedFrame('\\{"connectedAt":"[^"]+","resumed":true\\}'));
    expect(numbered(person).map((f) => [f.event, f.data])).toEqual([
      ['config_changed', '{"sections":["spaces"]}'],
      ['agents_changed', '{"kind":"updated","agentId":"a1"}'],
    ]);
    // The program could not have received the operator's frame live.
    expect(numbered(program).map((f) => [f.event, f.data])).toEqual([
      ['agents_changed', '{"kind":"updated","agentId":"a1"}'],
    ]);
    expect(numbered(program)[0]!.id).toBe(numbered(person)[1]!.id);
  });

  it('refuses an agent, with or without a cursor', async () => {
    const cursor = await marker();
    for (const headers of [AGENT, { ...AGENT, 'last-event-id': cursor }]) {
      const res = await fetch(`${baseUrl}/api/events`, { headers });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'person_only' });
    }
  });

  it('gives a cursor no rights: another reader’s cursor replays only what the resuming reader may read', async () => {
    members.add('u1');
    const audience = roomAudience('r1', rooms);
    const owner = stream(asProgram('u1'));
    await owner((t) => t.includes('event: connected'));
    eventFanOut.broadcast('tasks_changed', { before: true });
    const cursor = numbered(await owner((t) => t.includes('"before":true'))).at(-1)!.id;
    eventFanOut.broadcast('room_updated', { roomId: 'r1', secret: true }, audience);
    eventFanOut.broadcast('tasks_changed', { after: true });
    const done = (t: string): boolean => t.includes('"after":true');

    // The cursor's own reader replays the room event; another program, and the
    // operator (who is not in the room), resuming from the same cursor do not.
    const mine = await read({ ...asProgram('u1'), 'last-event-id': cursor }, done);
    expect(numbered(mine).map((f) => f.event)).toEqual(['room_updated', 'tasks_changed']);
    for (const headers of [asProgram('u2'), {}]) {
      const theirs = await read({ ...headers, 'last-event-id': cursor }, done);
      expect(theirs).toContain('"resumed":true');
      expect(numbered(theirs).map((f) => f.event)).toEqual(['tasks_changed']);
    }
  });

  it('stops a live room’s events at the next frame once the reader leaves it', async () => {
    members.add('u1');
    const audience = roomAudience('r1', rooms);
    const live = stream(asProgram('u1'));
    await live((t) => t.includes('event: connected'));
    eventFanOut.broadcast('room_updated', { roomId: 'r1', n: 1 }, audience);
    await live((t) => t.includes('"n":1'));
    members.delete('u1');
    eventFanOut.broadcast('room_updated', { roomId: 'r1', n: 2 }, audience);
    eventFanOut.broadcast('tasks_changed', { after: 'left' });
    const text = await live((t) => t.includes('"after":"left"'));
    expect(numbered(text).map((f) => f.data)).toEqual([
      '{"roomId":"r1","n":1}',
      '{"after":"left"}',
    ]);
  });

  it('stops a chat’s frames at the next frame once the reader may no longer read it', async () => {
    // The chat list's audience is the space side's rule, asked as each frame is
    // written: when its answer changes, the next frame follows it.
    const readable = new Set(['u1']);
    const chat = (principal: CallerPrincipal): boolean =>
      principal.kind === 'program' && readable.has(principal.userId);
    const live = stream(asProgram('u1'));
    await live((t) => t.includes('event: connected'));
    eventFanOut.broadcast('session_status', { sessionId: 's1', n: 1 }, chat);
    await live((t) => t.includes('"n":1'));
    readable.delete('u1');
    eventFanOut.broadcast('session_status', { sessionId: 's1', n: 2 }, chat);
    eventFanOut.broadcast('tasks_changed', { after: 'private' });
    const text = await live((t) => t.includes('"after":"private"'));
    expect(numbered(text).map((f) => f.data)).toEqual([
      '{"sessionId":"s1","n":1}',
      '{"after":"private"}',
    ]);
  });

  it('filters a replay with the rights the reader has when it resumes, not when sent', async () => {
    // Pinned on purpose: whether a replay should use the rights at send time
    // is Security's call. Changing it must change this test.
    let admitted = false;
    const cursor = await marker();
    eventFanOut.broadcast('room_updated', { roomId: 'r1' }, () => admitted);
    admitted = true;
    eventFanOut.broadcast('agents_changed', { kind: 'updated', agentId: 'a2' });
    const text = await read({ 'last-event-id': cursor }, (t) => t.includes('"agentId":"a2"'));
    expect(numbered(text).map((f) => f.event)).toEqual(['room_updated', 'agents_changed']);
  });

  it('sends a live event right after the replay, in order', async () => {
    const cursor = await marker();
    eventFanOut.broadcast('tasks_changed', { missed: true });
    const resumed = stream({ 'last-event-id': cursor });
    await resumed((t) => t.includes('"missed":true'));
    eventFanOut.broadcast('tasks_changed', { live: true });
    const frames = numbered(await resumed((t) => t.includes('"live":true')));
    expect(frames.map((f) => f.data)).toEqual(['{"missed":true}', '{"live":true}']);
    expect(frames[1]!.seq).toBeGreaterThan(frames[0]!.seq);
  });

  it('replays an event with the seq and the time it was first sent', async () => {
    const live = stream({});
    await live((text) => text.includes('event: connected'));
    const cursor = await marker();
    eventFanOut.broadcast('tasks_changed', { first: true });
    const sent = numbered(await live((t) => t.includes('"first":true'))).at(-1)!;
    expect(new Date(sent.at).toISOString()).toBe(sent.at);

    const replayed = numbered(
      await read({ 'last-event-id': cursor }, (t) => t.includes('"first":true'))
    ).at(-1)!;
    expect(replayed).toEqual(sent);
  });

  it('resumes from ?resume= too, the cursor a socket sends', async () => {
    const cursor = await marker();
    eventFanOut.broadcast('tasks_changed', { after: true });
    const text = await read(
      {},
      (t) => t.includes('"after":true'),
      `/api/events?resume=${encodeURIComponent(cursor)}`
    );
    expect(text).toContain('"resumed":true');
  });

  it('is a cold connect when the cursor is older than the window, foreign or unknown', async () => {
    const cursor = await marker();
    for (let i = 0; i <= EVENT_REPLAY_LIMITS.maxEvents; i += 1) {
      eventFanOut.broadcast('tasks_changed', { i });
    }
    const stale = cursor.replace(/-g\d+-/, '-g999999-');
    for (const lastEventId of [cursor, stale, '42', `rooms${cursor.slice('events'.length)}`]) {
      const text = await read({ 'last-event-id': lastEventId }, (t) => t.includes('\n\n'));
      expect(text, lastEventId).toMatch(connectedFrame('\\{"connectedAt":"[^"]+"\\}'));
    }
  });
});

describe('tunnel status on GET /api/events (it replaced GET /api/tunnel/stream)', () => {
  /** The `tunnel_status` payloads in a body, in order. */
  const tunnelFrames = (text: string): unknown[] =>
    [...text.matchAll(/event: tunnel_status\ndata: (.*)\n\n/g)].map(
      ([, data]) => (JSON.parse(data!) as { payload: unknown }).payload
    );

  /**
   * Open a stream and read it until a live marker sent after the connect: the
   * opening frames go out in the connect's own tick, so all of them are in.
   */
  async function openingFrames(headers: Record<string, string>): Promise<string> {
    const reader = stream(headers);
    await reader((t) => t.includes('event: connected'));
    eventFanOut.broadcast('tasks_changed', { opened: headers['last-event-id'] ?? 'cold' });
    return reader((t) => t.includes('"opened"'));
  }

  it('opens with the current status, after any replay', async () => {
    const cursor = await marker();
    eventFanOut.broadcast('tunnel_status', { stale: true }, frontDoorReadAudience);

    const cold = await openingFrames({});
    expect(tunnelFrames(cold)).toEqual([tunnelManager.status]);
    expect(cold.indexOf('event: tunnel_status')).toBeGreaterThan(cold.indexOf('event: connected'));

    // The replayed change, then the snapshot, so the last one held is current.
    const resumed = await openingFrames({ 'last-event-id': cursor });
    expect(tunnelFrames(resumed)).toEqual([{ stale: true }, tunnelManager.status]);
  });

  it('sends a change live to the person and to their keys', async () => {
    const person = stream({});
    const program = stream(asProgram('u1'));
    await person((t) => t.includes('event: connected'));
    await program((t) => t.includes('event: connected'));
    eventFanOut.broadcast('tunnel_status', { live: 1 }, frontDoorReadAudience);
    eventFanOut.broadcast('tasks_changed', { after: 'tunnel' });
    for (const reader of [person, program]) {
      expect(tunnelFrames(await reader((t) => t.includes('"after":"tunnel"'))).at(-1)).toEqual({
        live: 1,
      });
    }
  });

  it('drops a tunnel_status that names no audience, so an unwired sender leaks nothing', async () => {
    const person = stream({});
    await person((t) => t.includes('event: connected'));
    // @ts-expect-error The tunnel's status must name who may read it.
    eventFanOut.broadcast('tunnel_status', { unaddressed: true });
    eventFanOut.broadcast('tasks_changed', { after: 'unaddressed' });
    expect(await person((t) => t.includes('"after":"unaddressed"'))).not.toContain(
      '"unaddressed":true'
    );
  });
});
