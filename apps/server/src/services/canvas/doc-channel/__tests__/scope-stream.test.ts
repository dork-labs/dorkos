import type { CanvasChannelNotification } from '@dorkos/shared/canvas-channel-schemas';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamFrame } from '@dorkos/shared/stream-socket';
import type { DurableStreamSink } from '../../../core/streams/durable-stream-sink.js';
import { deliverSessionStream } from '../../../core/streams/session-stream-delivery.js';
/** Real authorized storage replays without borrowing transcript or room entry cursors. */
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { canvasDocChannels, canvasDocEvents, eq, type Db, type DbTransaction } from '@dorkos/db';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { DocChannelAuthorization } from '../authorization.js';
import { DocChannelService } from '../service.js';
import { DocChannelLiveBuffer } from '../streams/live-buffer.js';
import { DocScopeStream } from '../streams/scope-stream.js';
import { harness, FROM, NOW, TO } from './lifecycle-fixtures.js';
const databases: Db[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.$client.close();
});
function fixture() {
  const f = harness();
  databases.push(f.db);
  let allowed = true;
  const actor = {
    surface: 'http' as const,
    principal: createServerPrincipal({
      kind: 'operator',
      owner: { kind: 'local_install', installationId: 'fixture' },
    }),
  };
  const authorization = new DocChannelAuthorization(f.db, f.documents, {
    ownsInstallation: (claims) =>
      claims.owner.kind === 'local_install' && claims.owner.installationId === 'fixture',
    roomMembership: () => undefined,
    principalCurrent: () => allowed,
  });
  const ports = {
    resolveScope: (scope: string) => f.documents.lifecycle.resolveScope(scope),
    requireScopeCurrent: (scope: string, caller: typeof actor): undefined => {
      authorization.requireScopeCurrent(scope, caller);
      return undefined;
    },
    requireDocumentCurrent: (id: string, scope: string, caller: typeof actor): undefined => {
      if (authorization.requireCurrent(id, caller).scope !== scope) throw new Error('Wrong scope');
      return undefined;
    },
  };
  const service = new DocChannelService(f.documents, f.store, authorization);
  const live = new DocChannelLiveBuffer(f.store, ports);
  const stream = new DocScopeStream(f.documents, service, live, ports);
  const doc = f.canvas.open(FROM, 'agent', { type: 'file', sourcePath: '/fake/lifeos/tasks.md' });
  const append = (tx?: DbTransaction) =>
    f.store.appendEvent(
      {
        documentId: doc.id,
        eventId: randomUUID(),
        direction: 'system',
        type: 'state.changed',
        payload: { stateRev: 1 },
        envelopeHash: 'a'.repeat(64),
        receivedAt: NOW,
        provenance: {},
      },
      tx
    );
  const controller = new AbortController();
  const reader = () => stream.subscribe(FROM, actor, controller.signal)[Symbol.asyncIterator]();
  return {
    ...f,
    doc,
    actor,
    service,
    authorization,
    live,
    stream,
    append,
    reader,
    controller,
    revoke: () => {
      allowed = false;
    },
  };
}
it('replays a cold idle document snapshot without manufacturing a transcript cursor', async () => {
  const f = fixture();
  const reader = f.reader();
  expect((await reader.next()).value).toMatchObject({
    type: 'canvas_channel_snapshot',
    documentId: f.doc.id,
    scope: FROM,
    snapshot: { highWatermark: 0, stateRev: 0 },
  });
  f.append();
  f.live.notifyCommitted(f.doc.id);
  expect((await reader.next()).value).toMatchObject({
    type: 'canvas_channel_snapshot',
    snapshot: { highWatermark: 1 },
  });
  const frame = (await reader.next()).value;
  expect(frame).toMatchObject({ type: 'canvas_event', docSeq: 1, scope: FROM });
  expect(frame).not.toHaveProperty('seq');
  expect(frame).not.toHaveProperty('entrySeq');
  f.controller.abort();
  await reader.return?.();
});
it('captures a commit during asynchronous hydration and emits it once after replay', async () => {
  const f = fixture();
  f.append();
  const original = f.service.replay.bind(f.service);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(f.service, 'replay').mockImplementationOnce(async (...args) => {
    const snapshot = await original(...args);
    await gate;
    return snapshot;
  });
  const reader = f.reader();
  const first = reader.next();
  await vi.waitFor(() => expect(f.service.replay).toHaveBeenCalledTimes(1));
  f.append();
  f.live.notifyCommitted(f.doc.id);
  release();
  expect((await first).value).toMatchObject({
    type: 'canvas_channel_snapshot',
    snapshot: { highWatermark: 1 },
  });
  expect((await reader.next()).value).toMatchObject({ type: 'canvas_event', docSeq: 1 });
  expect((await reader.next()).value).toMatchObject({
    type: 'canvas_channel_snapshot',
    snapshot: { highWatermark: 2 },
  });
  expect((await reader.next()).value).toMatchObject({ type: 'canvas_event', docSeq: 2 });
  f.controller.abort();
  await reader.return?.();
});
it('replays all payload pages after reset even when receipt summaries contain newer sequences', async () => {
  const f = fixture();
  f.store.transaction(() => {
    for (let index = 0; index < 405; index++) f.append();
  });
  f.db
    .update(canvasDocEvents)
    .set({ payloadPrunedAt: NOW })
    .where(eq(canvasDocEvents.docSeq, 1))
    .run();
  f.db
    .update(canvasDocChannels)
    .set({ retentionFloor: 2 })
    .where(eq(canvasDocChannels.documentId, f.doc.id))
    .run();
  const reader = f.reader();
  const sequences: number[] = [];
  let snapshots = 0;
  while (sequences.length < 404) {
    const frame = (await reader.next()).value!;
    if (frame.type === 'canvas_event') sequences.push(frame.docSeq);
    else snapshots++;
  }
  expect(sequences).toEqual(Array.from({ length: 404 }, (_, index) => index + 2));
  expect(snapshots).toBe(3);
  f.controller.abort();
  await reader.return?.();
});
it('rechecks principal authority between a snapshot and its next payload frame', async () => {
  const f = fixture();
  f.append();
  const reader = f.reader();
  await reader.next();
  f.revoke();
  await expect(reader.next()).rejects.toMatchObject({ status: 404 });
});
it('continues with current canonical scope after a verified identity move', async () => {
  const f = fixture();
  const reader = f.reader();
  await reader.next();
  expect(f.documents.rekeyScope(FROM, TO)).toBe(1);
  f.append();
  f.live.notifyCommitted(f.doc.id);
  expect((await reader.next()).value).toMatchObject({ type: 'canvas_channel_snapshot', scope: TO });
  expect((await reader.next()).value).toMatchObject({ type: 'canvas_event', scope: TO, docSeq: 1 });
  f.controller.abort();
  await reader.return?.();
});
it('denies an unrelated scope before enumerating document identities', () => {
  const f = fixture();
  const identities = vi.spyOn(f.documents, 'identities');
  const unrelated = {
    ...f.actor,
    principal: createServerPrincipal({
      kind: 'operator',
      owner: { kind: 'user', userId: 'stranger' },
    }),
  };
  expect(() => f.stream.subscribe(FROM, unrelated, f.controller.signal)).toThrow();
  expect(identities).not.toHaveBeenCalled();
});

it('delivers document updates on the actual common session stream while the runtime is idle', async () => {
  const f = fixture();
  const runtime = new FakeAgentRuntime();
  runtime.subscribeSession.mockImplementation(async function* (_ctx, _id, _cursor, signal) {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  });
  const frames: StreamFrame[] = [];
  const sink: DurableStreamSink = {
    signal: f.controller.signal,
    get closed() {
      return f.controller.signal.aborted;
    },
    send: async (frame) => {
      frames.push(frame);
    },
    end: () => f.controller.abort(),
  };
  const delivered = deliverSessionStream(sink, {
    sessionId: 'session-1',
    runtime,
    ctx: { cwd: '/fake/lifeos', permissionMode: 'default' },
    resume: undefined,
    principal: { kind: 'operator' },
    documentNotifications: (signal) => f.stream.subscribe(FROM, f.actor, signal),
  });
  await vi.waitFor(() =>
    expect(frames.map((frame) => frame.event)).toEqual(['snapshot', 'canvas_channel_snapshot'])
  );
  f.append();
  f.live.notifyCommitted(f.doc.id);
  await vi.waitFor(() => expect(frames).toHaveLength(4));
  expect(frames[2]).toMatchObject({ event: 'canvas_channel_snapshot' });
  expect(frames[3]).toMatchObject({ event: 'canvas_event', data: { docSeq: 1 } });
  expect(frames[3]).not.toHaveProperty('id');
  expect(runtime.sendMessage).not.toHaveBeenCalled();
  f.controller.abort();
  await delivered;
});
it('explicit return releases an idle scope generator without an external abort', async () => {
  const f = fixture();
  const reader = f.reader();
  await reader.next();
  const pending = reader.next();
  await reader.return?.();
  expect((await pending).done).toBe(true);
  expect(f.controller.signal.aborted).toBe(false);
});

it('replays more than 2000 retained inputs on cold connect and reconnect with bounded pages', async () => {
  const f = fixture();
  const rows = f.store.transaction((tx) => Array.from({ length: 2001 }, () => f.append(tx)));
  const replay = vi.spyOn(f.service, 'replay');
  const expected = rows.map((row) => ({ id: row.eventId, docSeq: row.docSeq }));
  for (let connection = 0; connection < 2; connection++) {
    const reader = f.reader();
    const events: { id: string; docSeq: number }[] = [];
    let snapshots = 0;
    try {
      while (events.length < rows.length) {
        const frame = (await reader.next()).value!;
        if (frame.type === 'canvas_event') {
          expect(frame.scope).toBe(FROM);
          events.push({ id: frame.event.id, docSeq: frame.docSeq });
        } else snapshots++;
      }
      expect(events).toEqual(expected);
      expect(snapshots).toBe(11);
      expect(replay).toHaveBeenCalledTimes((connection + 1) * 11);
      expect(
        replay.mock.calls.slice(connection * 11, (connection + 1) * 11).map((call) => call[2])
      ).toEqual(Array.from({ length: 11 }, (_, page) => page * 200));
      if (connection === 1) {
        const newest = f.append();
        f.live.notifyCommitted(f.doc.id);
        f.live.notifyCommitted(f.doc.id);
        expect((await reader.next()).value).toMatchObject({
          type: 'canvas_channel_snapshot',
          snapshot: { highWatermark: 2002 },
        });
        expect((await reader.next()).value).toMatchObject({
          type: 'canvas_event',
          docSeq: 2002,
          event: { id: newest.eventId },
        });
        const pending = reader.next();
        await reader.return?.();
        expect((await pending).done).toBe(true);
        expect(replay).toHaveBeenCalledTimes(23);
      }
    } finally {
      await reader.return?.();
    }
  }
  for (const [, , , limit] of replay.mock.calls) expect(limit).toBe(200);
});

it('ends retained replay at its first high watermark and then drains a captured live commit', async () => {
  const f = fixture();
  f.store.transaction(() => {
    for (let index = 0; index < 405; index++) f.append();
  });
  const original = f.service.replay.bind(f.service);
  let concurrent!: ReturnType<typeof f.append>;
  const replay = vi.spyOn(f.service, 'replay').mockImplementationOnce(async (...args) => {
    const snapshot = await original(...args);
    concurrent = f.append();
    f.live.notifyCommitted(f.doc.id);
    return snapshot;
  });
  const reader = f.reader();
  const sequences: number[] = [];
  try {
    while (sequences.length < 405) {
      const frame = (await reader.next()).value!;
      if (frame.type === 'canvas_event') sequences.push(frame.docSeq);
    }
    expect(sequences).toEqual(Array.from({ length: 405 }, (_, index) => index + 1));
    expect(replay).toHaveBeenCalledTimes(3);
    // The fourth replay is the buffered live hint, not an extension of the cold cutoff.
    expect((await reader.next()).value).toMatchObject({
      type: 'canvas_channel_snapshot',
      snapshot: { highWatermark: 406 },
    });
    expect(replay).toHaveBeenCalledTimes(4);
    expect((await reader.next()).value).toMatchObject({
      type: 'canvas_event',
      docSeq: 406,
      event: { id: concurrent.eventId },
    });
  } finally {
    f.controller.abort();
    await reader.return?.();
  }
});

it('cancels a large replay without fetching another page or leaking buffered payloads', async () => {
  const f = fixture();
  f.store.transaction(() => {
    for (let index = 0; index < 2001; index++) f.append();
  });
  const replay = vi.spyOn(f.service, 'replay');
  const reader = f.reader();
  expect((await reader.next()).value).toMatchObject({ type: 'canvas_channel_snapshot' });
  expect((await reader.next()).value).toMatchObject({ type: 'canvas_event', docSeq: 1 });
  f.controller.abort();
  expect((await reader.next()).done).toBe(true);
  f.append();
  f.live.notifyCommitted(f.doc.id);
  expect((await reader.next()).done).toBe(true);
  expect(replay).toHaveBeenCalledTimes(1);
  await reader.return?.();
});

it('rebinds held replay and every payload to the current canonical scope without changing identity', async () => {
  const f = fixture();
  const rows = [f.append(), f.append()];
  const original = f.service.replay.bind(f.service);
  let captured = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const replay = vi.spyOn(f.service, 'replay').mockImplementationOnce(async (...args) => {
    const snapshot = await original(...args);
    expect(snapshot.events[0]?.scope).toBe(FROM);
    captured = true;
    await gate;
    return snapshot;
  });
  const reader = f.reader();
  const first = reader.next();
  await vi.waitFor(() => expect(captured).toBe(true));
  expect(replay).toHaveBeenCalledTimes(1);
  expect(f.documents.rekeyScope(FROM, TO)).toBe(1);
  release();
  try {
    expect((await first).value).toMatchObject({ type: 'canvas_channel_snapshot', scope: TO });
    for (const row of rows) {
      expect((await reader.next()).value).toMatchObject({
        type: 'canvas_event',
        scope: TO,
        documentId: f.doc.id,
        docSeq: row.docSeq,
        event: { id: row.eventId },
      });
    }
    const newest = f.append();
    f.live.notifyCommitted(f.doc.id);
    expect((await reader.next()).value).toMatchObject({
      type: 'canvas_channel_snapshot',
      scope: TO,
    });
    expect((await reader.next()).value).toMatchObject({
      type: 'canvas_event',
      scope: TO,
      docSeq: 3,
      event: { id: newest.eventId },
    });
  } finally {
    f.controller.abort();
    await reader.return?.();
  }
});

it.each(['revocation', 'navigation'] as const)(
  'fences %s during held replay before any disclosure',
  async (reason) => {
    const f = fixture();
    f.append();
    const original = f.service.replay.bind(f.service);
    let captured = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replay = vi.spyOn(f.service, 'replay').mockImplementationOnce(async (...args) => {
      const snapshot = await original(...args);
      expect(snapshot.events[0]?.scope).toBe(FROM);
      captured = true;
      await gate;
      return snapshot;
    });
    const reader = f.reader();
    const frames: CanvasChannelNotification[] = [];
    const first = reader.next().then((result) => {
      if (!result.done) frames.push(result.value);
      return result;
    });
    await vi.waitFor(() => expect(captured).toBe(true));
    if (reason === 'revocation') f.revoke();
    else f.controller.abort();
    release();
    try {
      if (reason === 'revocation') await expect(first).rejects.toMatchObject({ status: 404 });
      else expect((await first).done).toBe(true);
      expect(frames).toEqual([]);
      expect(replay).toHaveBeenCalledTimes(1);
    } finally {
      f.controller.abort();
      await reader.return?.();
    }
  }
);
