import type { StreamFrame } from '@dorkos/shared/stream-socket';
import type { DurableStreamSink } from '../durable-stream-sink.js';
import {
  attachDocumentStream,
  serializedStreamSink,
  type SerializedStreamSink,
} from '../document-stream-delivery.js';
/** Real authorized storage replays without borrowing transcript or room entry cursors. */
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { type Db } from '@dorkos/db';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { DocChannelAuthorization } from '../../../canvas/doc-channel/authorization.js';
import { DocChannelService } from '../../../canvas/doc-channel/service.js';
import { DocChannelLiveBuffer } from '../../../canvas/doc-channel/streams/live-buffer.js';
import { DocScopeStream } from '../../../canvas/doc-channel/streams/scope-stream.js';
import {
  harness,
  FROM,
  NOW,
  TO,
} from '../../../canvas/doc-channel/__tests__/lifecycle-fixtures.js';
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
  const append = () =>
    f.store.appendEvent({
      documentId: doc.id,
      eventId: randomUUID(),
      direction: 'system',
      type: 'state.changed',
      payload: { stateRev: 1 },
      envelopeHash: 'a'.repeat(64),
      receivedAt: NOW,
      provenance: {},
    });
  const controller = new AbortController();

  return {
    ...f,
    doc,
    actor,
    service,
    authorization,
    live,
    stream,
    append,
    controller,
    revoke: () => {
      allowed = false;
    },
  };
}

/** Keep the ordinary frame in flight until the document producer has queued its next send. */
async function queuedDocument(
  f: ReturnType<typeof fixture>,
  target: 'canvas_event' | 'canvas_channel_snapshot' = 'canvas_event'
) {
  const frames: StreamFrame[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let queued!: Promise<void>;
  let ordinaryEntered = false;
  const raw: DurableStreamSink = {
    signal: f.controller.signal,
    get closed() {
      return f.controller.signal.aborted;
    },
    end: () => f.controller.abort(),
    send: async (frame) => {
      if (frame.event === 'ordinary') {
        ordinaryEntered = true;
        await gate;
      }
      if (!f.controller.signal.aborted) frames.push(frame);
      if (target === 'canvas_event' && frame.event === 'canvas_channel_snapshot')
        void lane.send({ event: 'ordinary', id: 'ordinary:41', data: { seq: 41 } });
    },
  };
  const serial = serializedStreamSink(raw);
  const lane: SerializedStreamSink = {
    signal: serial.signal,
    get closed() {
      return serial.closed;
    },
    end: () => serial.end(),
    send: (frame) => serial.send(frame),
    sendCurrent: (frame, prepare) => {
      const sending = serial.sendCurrent(frame, prepare);
      if (frame.event === target) queued = sending;
      return sending;
    },
  };
  const stream = f.stream.subscribe(FROM, f.actor, lane.signal);
  const iterator = stream[Symbol.asyncIterator]();
  const returned = vi.fn(
    () => iterator.return?.() ?? Promise.resolve({ done: true as const, value: undefined })
  );
  const documents = attachDocumentStream(lane, () => ({
    prepareForSend: (notification) => stream.prepareForSend(notification),
    [Symbol.asyncIterator]: () => ({ next: () => iterator.next(), return: returned }),
  }));
  if (target === 'canvas_channel_snapshot')
    void lane.send({ event: 'ordinary', id: 'ordinary:41', data: { seq: 41 } });
  documents.start();
  await vi.waitFor(() => expect(ordinaryEntered).toBe(true));
  await vi.waitFor(() => expect(queued).toBeDefined());
  return { frames, documents, returned, release, drain: () => queued.catch(() => {}) };
}

it('writes exactly one authorized document payload without borrowing the ordinary cursor', async () => {
  const f = fixture();
  f.append();
  const wire = await queuedDocument(f);
  try {
    wire.release();
    await wire.drain();
    const payloads = wire.frames.filter((frame) => frame.event === 'canvas_event');
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      data: { scope: FROM, documentId: f.doc.id, docSeq: 1, event: { payload: { stateRev: 1 } } },
    });
    expect(payloads[0]).not.toHaveProperty('id');
    expect(
      wire.frames.filter((frame) => frame.event === 'canvas_channel_snapshot')[0]
    ).not.toHaveProperty('id');
    expect(wire.frames.find((frame) => frame.event === 'ordinary')).toEqual({
      event: 'ordinary',
      id: 'ordinary:41',
      data: { seq: 41 },
    });
  } finally {
    f.controller.abort();
    wire.documents.stop();
  }
  await vi.waitFor(() => expect(wire.returned).toHaveBeenCalled());
});

it.each(['revoke', 'navigation', 'close'] as const)(
  'withholds queued document payload after %s',
  async (change) => {
    const f = fixture();
    f.append();
    const wire = await queuedDocument(f);
    try {
      if (change === 'revoke') f.revoke();
      else if (change === 'navigation') f.controller.abort();
      else f.canvas.close(FROM, f.doc.id);
      wire.release();
      await wire.drain();
      await vi.waitFor(() => expect(wire.returned).toHaveBeenCalled());
      expect(wire.frames.filter((frame) => frame.event === 'canvas_event')).toEqual([]);
      expect(wire.frames.some((frame) => frame.event === 'canvas_channel_snapshot')).toBe(true);
      if (change !== 'navigation')
        expect(wire.frames.find((frame) => frame.event === 'ordinary')?.id).toBe('ordinary:41');
    } finally {
      f.controller.abort();
      wire.documents.stop();
    }
  }
);

it.each(['canvas_channel_snapshot', 'canvas_event'] as const)(
  'stamps a queued %s with the current canonical scope',
  async (target) => {
    const f = fixture();
    f.append();
    const wire = await queuedDocument(f, target);
    try {
      expect(f.documents.rekeyScope(FROM, TO)).toBe(1);
      wire.release();
      await wire.drain();
      const current = wire.frames.filter((frame) => frame.event === target);
      expect(current).toHaveLength(1);
      expect(current[0]).toMatchObject({ data: { scope: TO, documentId: f.doc.id } });
      expect(current[0]).not.toHaveProperty('id');
      expect(wire.frames.find((frame) => frame.event === 'ordinary')).toEqual({
        event: 'ordinary',
        id: 'ordinary:41',
        data: { seq: 41 },
      });
    } finally {
      f.controller.abort();
      wire.documents.stop();
    }
    await vi.waitFor(() => expect(wire.returned).toHaveBeenCalled());
  }
);

it.each(['cancel', 'stop'] as const)(
  'cleans up the iterator without queued document IO after %s',
  async (change) => {
    const f = fixture();
    f.append();
    const wire = await queuedDocument(f, 'canvas_channel_snapshot');
    try {
      if (change === 'cancel') f.controller.abort();
      else wire.documents.stop();
      wire.release();
      await wire.drain();
      await vi.waitFor(() => expect(wire.returned).toHaveBeenCalled());
      expect(wire.frames.filter((frame) => frame.event.startsWith('canvas_'))).toEqual([]);
    } finally {
      f.controller.abort();
      wire.documents.stop();
    }
  }
);

it('keeps later ordinary work usable after a queued document guard refuses', async () => {
  const controller = new AbortController();
  const frames: StreamFrame[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const raw: DurableStreamSink = {
    signal: controller.signal,
    get closed() {
      return controller.signal.aborted;
    },
    end: () => controller.abort(),
    send: async (frame) => {
      if (frame.id === 'ordinary:41') await gate;
      frames.push(frame);
    },
  };
  const lane = serializedStreamSink(raw);
  const first = { event: 'ordinary', id: 'ordinary:41', data: { seq: 41 } };
  const last = { event: 'ordinary', id: 'ordinary:42', data: { seq: 42 } };
  const refusal = new Error('Document authority revoked');
  const prepare = vi.fn((): StreamFrame => {
    throw refusal;
  });
  const preceding = lane.send(first);
  const guarded = lane.sendCurrent({ event: 'canvas_event', data: { private: true } }, prepare);
  // Attach the rejection assertion before releasing the lane to avoid an unhandled rejection.
  const refused = expect(guarded).rejects.toBe(refusal);
  const following = lane.send(last);
  expect(prepare).not.toHaveBeenCalled();
  release();
  await Promise.all([preceding, refused, following]);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(frames).toEqual([first, last]);
  expect(controller.signal.aborted).toBe(false);
  controller.abort();
});
