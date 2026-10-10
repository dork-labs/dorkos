/** Real room storage and document streams use both existing wire protocols. */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { WebSocket } from 'ws';
import type { StreamFrame } from '@dorkos/shared/stream-socket';
import type { Db } from '@dorkos/db';
import { createRoomHarness } from '../../../rooms/__tests__/room-test-harness.js';
import { setRoomService } from '../../../rooms/index.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { DocChannelAuthorization } from '../../../canvas/doc-channel/authorization.js';
import { DocChannelStore } from '../../../canvas/doc-channel/store.js';
import { DocChannelService } from '../../../canvas/doc-channel/service.js';
import { DocChannelLiveBuffer } from '../../../canvas/doc-channel/streams/live-buffer.js';
import { DocScopeStream } from '../../../canvas/doc-channel/streams/scope-stream.js';
import { setDocScopeNotificationsFactory } from '../../../canvas/doc-channel/streams/registry.js';
import { resolveCaller } from '../../../../routes/room-caller.js';
import { roomEventsHandler } from '../../../../routes/room-events-handler.js';
import { roomEventsRoute } from '../../../../routes/room-events-socket.js';
import { deliverRoomStream } from '../room-stream-delivery.js';
import type { DurableStreamSink } from '../durable-stream-sink.js';

// Credential gates have their own route tests. Only caller identity is fixed here;
// the room, its membership, document read checks, broadcaster, and sinks are real.
vi.mock('../../../../routes/room-caller.js', () => ({ resolveCaller: vi.fn() }));
const databases: Db[] = [];
const sinks: { end(): void }[] = [];
afterEach(() => {
  sinks.splice(0).forEach((sink) => sink.end());
  setDocScopeNotificationsFactory(undefined);
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.$client.close());
});
function fixture() {
  const f = createRoomHarness({ agents: { byPath: () => null }, indexEntry: () => {} });
  databases.push(f.db);
  setRoomService(f.service);
  const room = f.service.createRoom(
    { kind: 'channel', title: 'Fixture', members: [], agentPaths: [] },
    f.human
  );
  const scope = `room:${room.id}`;
  const doc = f.service.canvas.open(room.id, f.human, {
    type: 'json',
    data: {},
    title: 'Fixture app',
  });
  const store = new DocChannelStore(f.db);
  let current = true;
  const actor = {
    surface: 'http' as const,
    principal: createServerPrincipal({
      kind: 'operator',
      owner: { kind: 'local_install', installationId: 'fixture' },
    }),
  };
  const authorization = new DocChannelAuthorization(f.db, f.canvasDocuments, {
    ownsInstallation: (claims) =>
      claims.owner.kind === 'local_install' && claims.owner.installationId === 'fixture',
    principalCurrent: () => current,
    roomMembership: (roomId) => {
      const row = f.store.getRoom(roomId);
      return row && f.store.getMember(roomId, f.human) ? { archived: row.archived } : undefined;
    },
  });
  const ports = {
    resolveScope: (value: string) => f.canvasDocuments.lifecycle.resolveScope(value),
    requireScopeCurrent: (value: string, caller: typeof actor): undefined => {
      authorization.requireScopeCurrent(value, caller);
      return undefined;
    },
    requireDocumentCurrent: (id: string, value: string, caller: typeof actor): undefined => {
      if (authorization.requireCurrent(id, caller).scope !== value) throw new Error('Wrong scope');
      return undefined;
    },
  };
  const channel = new DocChannelService(f.canvasDocuments, store, authorization);
  const live = new DocChannelLiveBuffer(store, ports);
  const documents = new DocScopeStream(f.canvasDocuments, channel, live, ports);
  const notifications = (signal: AbortSignal) => documents.subscribe(scope, actor, signal);
  vi.mocked(resolveCaller).mockReturnValue(f.authors.getById(f.human)!);
  const append = () => {
    const event = store.appendEvent({
      documentId: doc.id,
      eventId: randomUUID(),
      direction: 'system',
      type: 'state.changed',
      payload: { updated: true },
      provenance: {},
      envelopeHash: 'a'.repeat(64),
      receivedAt: '2026-10-01T00:00:00.000Z',
    });
    live.notifyCommitted(doc.id);
    return event;
  };
  const post = (text = 'hello') => f.service.post(room.id, { authorId: f.human, text });
  return {
    ...f,
    room,
    scope,
    doc,
    store,
    channel,
    live,
    documents,
    notifications,
    append,
    post,
    revoke: () => {
      current = false;
    },
  };
}
class RecordingSink implements DurableStreamSink {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  readonly frames: StreamFrame[] = [];
  get closed() {
    return this.signal.aborted;
  }
  async send(frame: StreamFrame) {
    this.frames.push(frame);
  }
  end() {
    this.controller.abort();
  }
}
class ResponseProbe extends EventEmitter {
  readonly chunks: string[] = [];
  locals: Record<string, unknown> = {};
  writableEnded = false;
  writeHead = vi.fn();
  write(value: string) {
    this.chunks.push(value);
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit('close');
  }
  frames(): StreamFrame[] {
    return this.chunks
      .join('')
      .split('\n\n')
      .filter((block) => block.startsWith('event:') || block.startsWith('id:'))
      .map((block) => {
        const lines = block.split('\n');
        const id = lines.find((line) => line.startsWith('id: '))?.slice(4);
        return {
          event: lines.find((line) => line.startsWith('event: '))!.slice(7),
          data: JSON.parse(lines.find((line) => line.startsWith('data: '))!.slice(6)),
          ...(id ? { id } : {}),
        };
      });
  }
}
class SocketProbe extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  readonly frames: StreamFrame[] = [];
  send(payload: string) {
    this.frames.push(JSON.parse(payload));
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  end() {
    this.close();
  }
}

async function until(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true));
}
const documentEvents = (frames: StreamFrame[]) =>
  frames.filter((frame) => frame.event === 'canvas_event');

describe('common room document notifications', () => {
  it.each(['sse', 'socket'] as const)(
    'delivers idle document changes over the actual %s room handler without entry cursors',
    async (protocol) => {
      const f = fixture();
      const factory = vi.fn((_scope, _req, _res) => f.notifications);
      setDocScopeNotificationsFactory(factory);
      const req = { params: { id: f.room.id }, headers: {}, query: {} } as unknown as Request<{
        id: string;
      }>;
      let completion: Promise<void> | undefined;
      let frames: () => StreamFrame[];
      let end: () => void;
      let closed: () => boolean;
      if (protocol === 'sse') {
        const res = new ResponseProbe();
        sinks.push(res);
        const next = vi.fn();
        completion = roomEventsHandler(req, res as unknown as Response, next);
        frames = () => res.frames();
        end = () => res.end();
        closed = () => res.writableEnded;
        expect(next).not.toHaveBeenCalled();
        expect(res.writeHead).toHaveBeenCalledWith(
          200,
          expect.objectContaining({ 'Content-Type': 'text/event-stream' })
        );
      } else {
        const socket = new SocketProbe();
        sinks.push(socket);
        const path = `/api/rooms/${f.room.id}/events`;
        const decision = await roomEventsRoute.authorize({
          url: new URL(`http://localhost${path}`),
          headers: {},
          match: /^\/api\/rooms\/([^/]+)\/events$/.exec(path)!,
          locals: {},
        });
        expect(decision.ok).toBe(true);
        if (!decision.ok) throw new Error('Room was refused');
        decision.open(socket as unknown as WebSocket);
        frames = () => socket.frames;
        end = () => socket.end();
        closed = () => socket.readyState === 3;
      }
      try {
        await until(() => frames().some((frame) => frame.event === 'canvas_channel_snapshot'));
        expect(frames()[0]!.event).toBe('snapshot');
        expect(factory).toHaveBeenCalledWith(
          f.scope,
          expect.objectContaining({ headers: {} }),
          expect.objectContaining({ locals: expect.any(Object) })
        );
        const initialCursor = f.service.maxSeq(f.room.id);
        f.append();
        await until(() => documentEvents(frames()).length === 1);
        expect(f.service.maxSeq(f.room.id)).toBe(initialCursor);
        const posted = f.post();
        await until(() =>
          frames().some(
            (frame) => frame.event === 'entry' && (frame.data as { seq: number }).seq === posted.seq
          )
        );
        f.append();
        await until(() => documentEvents(frames()).length === 2);
        expect(
          documentEvents(frames()).map((frame) => (frame.data as { docSeq: number }).docSeq)
        ).toEqual([1, 2]);
        for (const frame of frames().filter((frame) => frame.event.startsWith('canvas_'))) {
          expect(frame).not.toHaveProperty('id');
          expect(frame.data).not.toHaveProperty('seq');
          expect(frame.data).not.toHaveProperty('entrySeq');
        }
        const entry = frames().find((frame) => frame.event === 'entry')!;
        expect(entry.id).toEqual(expect.stringMatching(new RegExp(`-${posted.seq}$`)));
        // The post plus the room's "no agent is in this channel" notice, since
        // the fixture room has no agent in it (DOR-2823).
        expect(f.service.maxSeq(f.room.id)).toBe(posted.seq + 1);
        f.revoke();
        f.append();
        await until(closed);
        expect(documentEvents(frames())).toHaveLength(2);
      } finally {
        end();
        await completion;
        await until(() => f.broadcaster.subscriberCount(f.room.id) === 0);
      }
    }
  );

  it.each([undefined, 0])(
    'subscribes both lanes before %s-cursor hydration and never loses an intervening commit',
    async (sinceCursor) => {
      const f = fixture();
      const sink = new RecordingSink();
      sinks.push(sink);
      const subscribe = vi.spyOn(f.live, 'subscribe');
      const hydrate = () => {
        expect(f.broadcaster.subscriberCount(f.room.id)).toBe(1);
        expect(subscribe).toHaveBeenCalledTimes(1);
        f.append();
        f.post('during hydration');
      };
      if (sinceCursor === undefined) {
        const original = f.service.snapshot.bind(f.service);
        vi.spyOn(f.service, 'snapshot').mockImplementationOnce((...args) => {
          hydrate();
          return original(...args);
        });
      } else {
        const original = f.service.entriesAfter.bind(f.service);
        vi.spyOn(f.service, 'entriesAfter').mockImplementationOnce((...args) => {
          hydrate();
          return original(...args);
        });
      }
      const running = deliverRoomStream(sink, {
        roomId: f.room.id,
        viewerAuthorId: f.human,
        sinceCursor,
        documentNotifications: f.notifications,
      });
      try {
        await until(
          () =>
            documentEvents(sink.frames).length === 1 &&
            sink.frames.filter((frame) => frame.event === 'canvas_channel_snapshot').length >= 2
        );
        expect(documentEvents(sink.frames)[0]!.data).toMatchObject({
          docSeq: 1,
          documentId: f.doc.id,
        });
        // The post at seq 1, then the room's "no agent is in this channel" notice
        // at seq 2, since the fixture room has no agent in it (DOR-2823).
        expect(f.service.maxSeq(f.room.id)).toBe(2);
        if (sinceCursor === undefined) {
          expect(sink.frames[0]!.event).toBe('snapshot');
          expect(sink.frames[0]!.data).toMatchObject({
            cursor: 2,
            entries: [expect.objectContaining({ seq: 1 }), expect.objectContaining({ seq: 2 })],
          });
          expect(sink.frames.filter((frame) => frame.event === 'entry')).toHaveLength(0);
        } else expect(sink.frames.filter((frame) => frame.event === 'entry')).toHaveLength(2);
      } finally {
        sink.end();
        await running;
      }
    }
  );

  it('serializes a blocked live entry and independent document frames in one write lane', async () => {
    const f = fixture();
    const sink = new RecordingSink();
    sinks.push(sink);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = sink.send.bind(sink);
    let inFlight = 0;
    let maximum = 0;
    vi.spyOn(sink, 'send').mockImplementation(async (frame) => {
      inFlight++;
      maximum = Math.max(maximum, inFlight);
      await original(frame);
      if (frame.event === 'entry') await blocked;
      inFlight--;
    });
    const running = deliverRoomStream(sink, {
      roomId: f.room.id,
      viewerAuthorId: f.human,
      sinceCursor: undefined,
      documentNotifications: f.notifications,
    });
    try {
      await until(() => sink.frames.some((frame) => frame.event === 'canvas_channel_snapshot'));
      f.post();
      await until(() => sink.frames.some((frame) => frame.event === 'entry'));
      f.append();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(documentEvents(sink.frames)).toHaveLength(0);
      expect(inFlight).toBe(1);
      release();
      await until(() => documentEvents(sink.frames).length === 1);
      expect(maximum).toBe(1);
      expect(sink.frames.findIndex((frame) => frame.event === 'entry')).toBeLessThan(
        sink.frames.findIndex((frame) => frame.event === 'canvas_event')
      );
    } finally {
      release();
      sink.end();
      await running;
    }
  });

  it('current document authority loss closes the enclosing idle room subscription', async () => {
    const f = fixture();
    const sink = new RecordingSink();
    sinks.push(sink);
    const running = deliverRoomStream(sink, {
      roomId: f.room.id,
      viewerAuthorId: f.human,
      sinceCursor: undefined,
      documentNotifications: f.notifications,
    });
    await until(() => sink.frames.some((frame) => frame.event === 'canvas_channel_snapshot'));
    f.revoke();
    f.append();
    await running;
    expect(sink.closed).toBe(true);
    expect(f.broadcaster.subscriberCount(f.room.id)).toBe(0);
    expect(documentEvents(sink.frames)).toHaveLength(0);
  });
});
