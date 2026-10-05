/** @vitest-environment jsdom */
/** Genuine recovery issuance plus helper host-load controls. UNRUN; no native-browser claim. */
import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { createMockTransport } from '@dorkos/test-utils';
import { ownDocChannelConnection } from '@/layers/shared/lib/transport/doc-channel-ownership';
import { FrameLifetimeController } from '@/layers/shared/lib/canvas-doc-frame';
import { createDocChannelRecovery } from '../model/doc-channel-recovery';
import { emptyDocChannelView } from '../model/doc-channel-view';
const birth = {
  v: 1 as const,
  documentId: 'doc',
  physicalOpenedAt: '2026-10-02T00:00:00Z',
  channelCreatedAt: '2026-10-02T00:00:01Z',
  generation: 'a'.repeat(64),
};
const replay = () => ({
  incarnation: birth,
  events: [],
  state: {},
  stateRev: 0,
  highWatermark: 0,
  retentionFloor: 1,
  receiptRetentionFloor: 1,
  resetRequired: false,
  receipts: [],
  health: { status: 'ready' as const, reasons: [] },
  routing: { enabled: true, destinationLabel: 'Tasks', approvedEventTypes: ['save'] },
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  document.body.replaceChildren();
});
async function owned(beforeReplay?: (transport: ReturnType<typeof createMockTransport>) => void) {
  const transport = createMockTransport();
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay());
  beforeReplay?.(transport);
  let view = emptyDocChannelView('doc', transport);
  const recovery = createDocChannelRecovery('doc', transport, (update) => {
    view = typeof update === 'function' ? update(view) : update;
  });
  cleanups.push(recovery.dispose);
  await waitFor(() => expect(view.binding?.verified).toBe(true));
  return {
    transport,
    dispose: recovery.dispose,
    get view() {
      return view;
    },
  };
}
function host(owner: object) {
  const element = document.createElement('iframe');
  document.body.append(element);
  const controller = new FrameLifetimeController();
  const context = {
    frame: element.contentWindow,
    documentId: 'doc',
    resolvedSource: '/doc',
    logicalUrl: '/doc',
    reloadKey: 'one',
    sessionId: 'session',
    eligibility: 'served-document' as const,
    exactOrigin: 'null',
    transportOwner: owner,
    publisherEpoch: 1,
  };
  const observation = controller.observeHostContext(context)!;
  return { element, controller, context, observation };
}
it('refuses an already loaded first-ever A host even when genuine HTTP B is now owned', async () => {
  let f!: ReturnType<typeof host>,
    old!: NonNullable<ReturnType<FrameLifetimeController['observeLoaded']>>;
  const h = await owned((transport) => {
    f = host(transport);
    old = f.controller.observeLoaded(f.observation)!;
  });
  expect(h.view.frameAdmission!.prepareFrameLoad(f.controller, old)).toBeNull();
  expect(h.view.frameAdmission!.attachFrame(f.controller, old)).toBeNull();
  const next = f.controller.observeHostContext({ ...f.context, reloadKey: 'fresh' })!;
  const ticket = h.view.frameAdmission!.prepareFrameLoad(f.controller, next)!;
  expect(ticket).not.toBeNull();
  // Prospective consumer calls this only from its captured actual onLoad handler after navigation.
  const loaded = ticket.completeLoad()!;
  expect(loaded.loaded).toBe(true);
  expect(h.view.frameAdmission!.attachFrame(f.controller, loaded)).not.toBeNull();
});
it('refuses a prepare ticket if retirement callback retires the genuine recovery owner before load completes', async () => {
  const h = await owned(),
    f = host(h.transport);
  const ticket = h.view.frameAdmission!.prepareFrameLoad(f.controller, f.observation)!;
  f.controller.subscribe(h.dispose);
  expect(ticket.completeLoad()).toBeNull();
  expect(h.view.frameAdmission!.attachFrame(f.controller, f.controller.getCurrent()!)).toBeNull();
});
it('keeps original inspection but never revives the captured submit after it was attempted', async () => {
  const h = await owned();
  const event = {
    v: 1 as const,
    id: '00000000-0000-4000-8000-000000000001',
    type: 'save',
    payload: {},
  };
  vi.mocked(h.transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('lost'));
  vi.mocked(h.transport.getCanvasEventReceipt).mockRejectedValueOnce(
    Object.assign(new Error('missing'), { status: 404 })
  );
  const original = h.view.binding!.captureOriginal(event)!;
  await expect(original.submit(new AbortController().signal)).rejects.toThrow('lost');
  await expect(original.inspect(new AbortController().signal)).rejects.toMatchObject({
    status: 404,
  });
  await expect(original.submit(new AbortController().signal)).rejects.toMatchObject({
    status: 409,
  });
  expect(h.transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
  expect(h.transport.getCanvasEventReceipt).toHaveBeenCalledWith(
    'doc',
    event.id,
    { expectedGeneration: birth.generation },
    expect.any(AbortSignal)
  );
});

it('does not replace the private HTTP baseline with a genuine owned stream snapshot floor', async () => {
  const h = await owned();
  const event = {
    v: 1 as const,
    id: '00000000-0000-4000-8000-000000000002',
    type: 'save',
    payload: {},
  };
  const original = h.view.binding!.captureOriginal(event)!;
  const { events: _events, ...snapshot } = replay();
  const controller = new AbortController();
  const producer = ownDocChannelConnection(h.transport, controller.signal);
  producer.publish({
    type: 'canvas_channel_snapshot',
    documentId: 'doc',
    scope: 'session:scope',
    snapshot: { ...snapshot, highWatermark: 50, retentionFloor: 9, receiptRetentionFloor: 9 },
  });
  await waitFor(() => expect(h.view.snapshot?.receiptRetentionFloor).toBe(9));
  expect(original.current('submit')).toBe(true);
  // This discriminates baseline-origin replacement, not the unadopted SQL absence/floor proof.
  controller.abort();
});

it.each(['accepted-b', 'rejected'] as const)(
  'genuine owned Transport mutation cannot change original correlation (%s)',
  async (outcome) => {
    const h = await owned(),
      id = '00000000-0000-4000-8000-000000000003',
      otherId = '00000000-0000-4000-8000-000000000004';
    const input = { v: 1 as const, id, type: 'save', payload: { nested: { text: 'original' } } },
      bytes = JSON.stringify(input);
    vi.mocked(h.transport.ingestCanvasEvent).mockImplementationOnce(async (_documentId, event) => {
      event.id = otherId;
      (event.payload as { nested: { text: string } }).nested.text = 'changed';
      if (outcome === 'rejected') throw new Error('lost after mutation');
      return { receipt: { id: otherId, status: 'recorded', docSeq: 1 }, deliveries: [] };
    });
    const original = h.view.binding!.captureOriginal(input)!;
    await expect(original.submit(new AbortController().signal)).rejects.toThrow(
      outcome === 'rejected' ? 'lost after mutation' : 'does not match'
    );
    const accepted = { receipt: { id, status: 'recorded' as const, docSeq: 1 }, deliveries: [] };
    vi.mocked(h.transport.getCanvasEventReceipt).mockResolvedValueOnce(accepted);
    await expect(original.inspect(new AbortController().signal)).resolves.toEqual(accepted);
    expect(h.transport.getCanvasEventReceipt).toHaveBeenCalledWith(
      'doc',
      id,
      { expectedGeneration: birth.generation },
      expect.any(AbortSignal)
    );
    expect(original.id).toBe(id);
    expect(original.bytes).toBe(bytes);
    expect(JSON.stringify(input)).toBe(bytes);
    expect(h.transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
  }
);
it('genuine nested load from the last Window getter leaves its winner current', async () => {
  const h = await owned(),
    f = host(h.transport);
  const old = h.view.frameAdmission!.prepareFrameLoad(f.controller, f.observation)!.completeLoad()!;
  const frame = f.element.contentWindow!,
    descriptor = Object.getOwnPropertyDescriptor(frame, 'postMessage');
  let winner: ReturnType<NonNullable<typeof h.view.frameAdmission>['attachFrame']> = null;
  let newer: ReturnType<FrameLifetimeController['observeLoaded']> = null;
  Object.defineProperty(frame, 'postMessage', {
    configurable: true,
    get() {
      Object.defineProperty(frame, 'postMessage', { configurable: true, value: vi.fn() });
      const fresh = f.controller.observeHostContext({ ...f.context, reloadKey: 'nested' })!;
      newer = h.view.frameAdmission!.prepareFrameLoad(f.controller, fresh)!.completeLoad();
      winner = h.view.frameAdmission!.attachFrame(f.controller, newer!);
      return vi.fn();
    },
  });
  try {
    expect(() => h.view.frameAdmission!.attachFrame(f.controller, old)).toThrow();
    expect(winner).not.toBeNull();
    expect(winner!.current()).toBe(true);
    expect(f.controller.getCurrent()).toBe(newer);
  } finally {
    if (descriptor) Object.defineProperty(frame, 'postMessage', descriptor);
    else Reflect.deleteProperty(frame, 'postMessage');
    f.controller.retire();
  }
});

function replayFrame(seq: number, incarnation = birth) {
  return {
    type: 'canvas_event' as const,
    documentId: 'doc',
    scope: 'session:scope',
    docSeq: seq,
    incarnation,
    event: {
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      type: 'save',
      payload: { seq },
      direction: 'upstream' as const,
      receivedAt: '2026-10-02T00:00:02Z',
    },
  };
}
it.each(['page', 'pending'] as const)(
  'genuine owned replacement during %s dispatch resets successor query to zero',
  async (phase) => {
    const transport = createMockTransport(),
      controller = new AbortController();
    const producer = ownDocChannelConnection(transport, controller.signal);
    const nextBirth = {
      ...birth,
      generation: 'b'.repeat(64),
      physicalOpenedAt: '2026-10-02T00:00:03Z',
    };
    const queries: number[] = [];
    let replacementObserved = false;
    vi.mocked(transport.getCanvasChannel).mockImplementation(async (_id, options) => {
      const since = options?.since ?? 0;
      queries.push(since);
      if (replacementObserved)
        return {
          ...replay(),
          incarnation: nextBirth,
          highWatermark: 1,
          events: since < 1 ? [replayFrame(1, nextBirth)] : [],
        };
      if (since === 0) return { ...replay(), highWatermark: 99 };
      expect(since).toBe(99);
      return { ...replay(), highWatermark: 100, events: [replayFrame(100)] };
    });
    let view = emptyDocChannelView('doc', transport);
    const dispatch: Parameters<typeof createDocChannelRecovery>[2] = (update) => {
      view = typeof update === 'function' ? update(view) : update;
      if (!replacementObserved && view.events.at(-1)?.docSeq === (phase === 'page' ? 100 : 101)) {
        replacementObserved = true;
        const { events: _events, ...snapshot } = replay();
        producer.publish({
          type: 'canvas_channel_snapshot',
          documentId: 'doc',
          scope: 'session:scope',
          snapshot: { ...snapshot, incarnation: nextBirth, highWatermark: 1 },
        });
      }
    };
    const recovery = createDocChannelRecovery('doc', transport, dispatch);
    cleanups.push(() => {
      recovery.dispose();
      controller.abort();
    });
    await waitFor(() => expect(view.binding?.verified).toBe(true));
    producer.publish(replayFrame(101));
    await waitFor(() => expect(view.binding?.verified).toBe(true));
    await waitFor(() => expect(view.snapshot?.incarnation).toEqual(nextBirth));
    expect(queries).toEqual([0, 99, 0]);
    expect(view.events.map((frame) => [frame.incarnation?.generation, frame.docSeq])).toEqual([
      [nextBirth.generation, 1],
    ]);
    producer.publish(replayFrame(2, nextBirth));
    await waitFor(() => expect(view.events.at(-1)?.docSeq).toBe(2));
    expect(
      view.events.every((frame) => frame.incarnation?.generation === nextBirth.generation)
    ).toBe(true);
  }
);
it.each(['stable', 'same-birth-rekey', 'dispose'] as const)(
  'preserves current repair dispatch boundary for %s',
  async (kind) => {
    const transport = createMockTransport(),
      controller = new AbortController();
    const producer = ownDocChannelConnection(transport, controller.signal),
      queries: number[] = [];
    let transitioned = false;
    vi.mocked(transport.getCanvasChannel).mockImplementation(async (_id, options) => {
      const since = options?.since ?? 0;
      queries.push(since);
      if (since === 0) return { ...replay(), highWatermark: 99 };
      if (since === 99) return { ...replay(), highWatermark: 100, events: [replayFrame(100)] };
      expect(kind).toBe('same-birth-rekey');
      expect(since).toBe(100);
      return {
        ...replay(),
        highWatermark: 101,
        events: [{ ...replayFrame(101), scope: 'session:canonical' }],
      };
    });
    let view = emptyDocChannelView('doc', transport);
    const dispatch: Parameters<typeof createDocChannelRecovery>[2] = (update) => {
      view = typeof update === 'function' ? update(view) : update;
      if (transitioned || view.events.at(-1)?.docSeq !== 100 || kind === 'stable') return;
      transitioned = true;
      if (kind === 'dispose') recovery.dispose();
      else {
        const { events: _events, ...snapshot } = replay();
        producer.publish({
          type: 'canvas_channel_snapshot',
          documentId: 'doc',
          scope: 'session:canonical',
          snapshot: { ...snapshot, highWatermark: 101 },
        });
      }
    };
    const recovery = createDocChannelRecovery('doc', transport, dispatch);
    cleanups.push(() => {
      recovery.dispose();
      controller.abort();
    });
    await waitFor(() => expect(view.binding?.verified).toBe(true));
    const original = view.binding!;
    producer.publish(replayFrame(101));
    if (kind === 'dispose') {
      await waitFor(() => expect(transitioned).toBe(true));
      expect(original.current('read')).toBe(false);
      expect(queries).toEqual([0, 99]);
    } else {
      await waitFor(() => expect(view.events.at(-1)?.docSeq).toBe(101));
      await waitFor(() => expect(view.binding?.verified).toBe(true));
      expect(queries).toEqual(kind === 'stable' ? [0, 99] : [0, 99, 100]);
      expect(view.events.map((frame) => frame.docSeq)).toEqual([100, 101]);
    }
  }
);

it.each(['object', 'undefined', 'refuse'] as const)(
  'genuine owner acquire owns rollback before envelope delivery (%s)',
  async (kind) => {
    const h = await owned(),
      f = host(h.transport);
    const loaded = h.view
      .frameAdmission!.prepareFrameLoad(f.controller, f.observation)!
      .completeLoad()!;
    const binding = f.controller.bindDoc(loaded, birth, 'doc');
    const cleanup = vi.fn();
    f.controller.ownDoc(binding, () => {
      throw new Error('cleanup sibling');
    });
    f.controller.ownDoc(binding, cleanup);
    const readCurrent = f.controller.getCurrent.bind(f.controller);
    let reads = 0;
    const sentinel = new Error('acquire local failure');
    const check = vi.spyOn(f.controller, 'getCurrent').mockImplementation(() => {
      if (++reads === 2) {
        if (kind === 'refuse') return null;
        throw kind === 'undefined' ? undefined : sentinel;
      }
      return readCurrent();
    });
    let caught = false,
      cause: unknown,
      result: unknown;
    try {
      result = h.view.frameAdmission!.attachFrame(f.controller, loaded);
    } catch (error) {
      caught = true;
      cause = error;
    } finally {
      check.mockRestore();
    }
    expect(reads).toBe(2);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(f.controller.isCurrent(binding)).toBe(false);
    expect(f.controller.getCurrent()).toBe(loaded);
    if (kind === 'refuse') {
      expect(caught).toBe(false);
      expect(result).toBeNull();
    } else {
      expect(caught).toBe(true);
      expect(cause).toBe(kind === 'undefined' ? undefined : sentinel);
    }
    expect(h.transport.ingestCanvasEvent).not.toHaveBeenCalled();
    f.controller.retire();
  }
);
it('acquire-local refusal leaves the newer same-binding claim current', async () => {
  const h = await owned(),
    f = host(h.transport);
  const loaded = h.view
    .frameAdmission!.prepareFrameLoad(f.controller, f.observation)!
    .completeLoad()!;
  const readCurrent = f.controller.getCurrent.bind(f.controller);
  let reads = 0;
  let winner: ReturnType<FrameLifetimeController['acquireDoc']> | undefined;
  const check = vi.spyOn(f.controller, 'getCurrent').mockImplementation(() => {
    if (++reads === 2) {
      winner = f.controller.acquireDoc(loaded, birth, 'doc');
      return null;
    }
    return readCurrent();
  });
  try {
    expect(h.view.frameAdmission!.attachFrame(f.controller, loaded)).toBeNull();
  } finally {
    check.mockRestore();
  }
  expect(winner).toBeDefined();
  expect(f.controller.isCurrent(winner!.binding)).toBe(true);
  winner!.release();
  expect(f.controller.isCurrent(winner!.binding)).toBe(false);
  f.controller.retire();
});
