/** @vitest-environment jsdom */
/** Genuine owner/kernel and attached original operations. All controls UNRUN. */
import { afterEach, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import { FrameLifetimeController } from '@/layers/shared/lib/canvas-doc-frame';
import { createDocChannelOwner } from '../model/doc-channel-owner';
import { emptyDocChannelView } from '../model/doc-channel-view';
import {
  captureRecordSubject,
  readRecordSubject,
  recordSubjectCurrent,
} from '../model/doc-channel-owner-record';
import { buildOwnedLifecycle } from '../model/doc-channel-owner-custody';
import {
  createOwnedCustody,
  consumeOwnedConstruction,
  readOwnedProjection,
  ownedProjectionCurrent,
  disposeOwnedCustody,
  requireOwnedCustody,
} from '../model/doc-channel-owner-record';
import { createOwnedReplayLifetime, createOwnedReplayRun } from '../model/doc-channel-owner-replay';
import { createOwnedFrameFacade } from '../model/doc-channel-owner-frame';
import { ownDocChannelConnection } from '@/layers/shared/lib/transport/doc-channel-ownership';
import { subscribeDocChannelNotifications } from '@/layers/shared/lib/transport';
const birth = {
  v: 1 as const,
  documentId: 'doc',
  physicalOpenedAt: '2026-10-02T00:00:00Z',
  channelCreatedAt: '2026-10-02T00:00:01Z',
  generation: 'a'.repeat(64),
};
const response = () => ({
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
async function owned() {
  const transport = createMockTransport();
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(response());
  let view = emptyDocChannelView('doc', transport);
  const owner = createDocChannelOwner('doc', transport, (update) => {
    view = typeof update === 'function' ? update(view) : update;
  });
  cleanups.push(owner.dispose);
  const run = owner.beginRun(),
    page = await run.readPage();
  expect(run.consumePage(page!)).toEqual({ kind: 'frames', count: 0 });
  expect(run.finishPage(page!)).toBe('done');
  return {
    transport,
    owner,
    get view() {
      return view;
    },
  };
}
function host(transportOwner: object) {
  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  const controller = new FrameLifetimeController();
  const observation = controller.observeHostContext({
    frame: iframe.contentWindow,
    documentId: 'doc',
    resolvedSource: '/doc',
    logicalUrl: '/doc',
    reloadKey: 'one',
    sessionId: 'session',
    eligibility: 'served-document',
    exactOrigin: 'null',
    transportOwner,
    publisherEpoch: 1,
  })!;
  return { controller, observation };
}

const event = {
  v: 1 as const,
  id: '00000000-0000-4000-8000-000000000001',
  type: 'save',
  payload: {},
};
const accepted = {
  receipt: { id: event.id, status: 'recorded' as const, docSeq: 1 },
  deliveries: [],
};
async function attached() {
  const h = await owned();
  const f = host(h.transport);
  const facade = h.view.frameAdmission!;
  const navigation = facade.prepareFrameLoad(f.controller, f.observation);
  expect(navigation).not.toBeNull();
  const loaded = navigation!.completeLoad();
  expect(loaded).not.toBeNull();
  const port = facade.attachFrame(f.controller, loaded!);
  expect(port).not.toBeNull();
  return { ...h, ...f, loaded: loaded!, port: port! };
}
it('uses genuine HTTP ownership to qualify attached original submit AND inspect', async () => {
  const h = await attached();
  vi.mocked(h.transport.ingestCanvasEvent).mockResolvedValue(accepted);
  vi.mocked(h.transport.getCanvasEventReceipt).mockResolvedValue(accepted);
  expect(h.port.current()).toBe(true);
  const original = h.port.captureOriginal({ id: event.id, bytes: JSON.stringify(event) });
  expect(original).not.toBeNull();
  const submitSignal = new AbortController().signal;
  expect(await original!.submit(submitSignal)).toEqual({ kind: 'accepted', receipt: accepted });
  expect(h.transport.ingestCanvasEvent).toHaveBeenCalledWith(
    'doc',
    event,
    { expectedGeneration: birth.generation },
    submitSignal
  );
  const inspectSignal = new AbortController().signal;
  expect(await original!.inspect(inspectSignal)).toEqual({ kind: 'accepted', receipt: accepted });
  expect(h.transport.getCanvasEventReceipt).toHaveBeenCalledWith(
    'doc',
    event.id,
    { expectedGeneration: birth.generation },
    inspectSignal
  );
});
it('keeps a lost original uncertain and inspects its unchanged ID without reposting', async () => {
  const h = await attached();
  vi.mocked(h.transport.ingestCanvasEvent).mockRejectedValue(new Error('lost'));
  vi.mocked(h.transport.getCanvasEventReceipt).mockResolvedValue(accepted);
  const original = h.port.captureOriginal({ id: event.id, bytes: JSON.stringify(event) })!;
  expect(await original.submit(new AbortController().signal)).toEqual({ kind: 'uncertain' });
  expect(await original.inspect(new AbortController().signal)).toEqual({
    kind: 'accepted',
    receipt: accepted,
  });
  expect(h.transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
  expect(h.transport.getCanvasEventReceipt).toHaveBeenCalledTimes(1);
  expect(original.id).toBe(event.id);
  expect(original.bytes).toBe(JSON.stringify(event));
});
it('refuses Transport-as-key, foreign keys, and a valid subject owned elsewhere', async () => {
  const h = await attached();
  const subject = h.view.binding!.owner;
  expect(() => requireOwnedCustody(h.transport)).toThrow();
  expect(() => captureRecordSubject(h.transport)).toThrow();
  expect(() => recordSubjectCurrent({}, subject)).toThrow();
  expect(() => readRecordSubject(h.owner, subject)).toThrow();
  expect(h.port.current()).toBe(true);
});
it.each(['transport', 'epoch'] as const)(
  'invalidates original operations after actual observation %s replacement',
  async (change) => {
    const h = await attached();
    const original = h.port.captureOriginal({ id: event.id, bytes: JSON.stringify(event) })!;
    h.controller.observeHostContext({
      ...h.loaded,
      transportOwner: change === 'transport' ? createMockTransport() : h.transport,
      publisherEpoch: change === 'epoch' ? 2 : 1,
    });
    expect(h.port.current()).toBe(false);
    await expect(original.submit(new AbortController().signal)).rejects.toThrow();
    await expect(original.inspect(new AbortController().signal)).rejects.toThrow();
    expect(h.transport.ingestCanvasEvent).not.toHaveBeenCalled();
    expect(h.transport.getCanvasEventReceipt).not.toHaveBeenCalled();
  }
);
it('retires the original subject before physical cleanup and refuses later operations', async () => {
  const h = await attached();
  const original = h.port.captureOriginal({ id: event.id, bytes: JSON.stringify(event) })!;
  h.owner.dispose();
  expect(h.port.current()).toBe(false);
  await expect(original.inspect(new AbortController().signal)).rejects.toThrow();
  expect(h.transport.getCanvasEventReceipt).not.toHaveBeenCalled();
});

it('binds genuine equal-epoch preHTTP projection captures to their exact owners', async () => {
  const transportA = createMockTransport(),
    transportB = createMockTransport();
  const dispatchA = vi.fn(),
    dispatchB = vi.fn();
  const ownerA = createOwnedCustody('doc', transportA, dispatchA);
  const ownerB = createOwnedCustody('doc', transportB, dispatchB);
  createOwnedReplayLifetime(ownerA);
  createOwnedReplayLifetime(ownerB);
  createOwnedFrameFacade(ownerA);
  createOwnedFrameFacade(ownerB);
  cleanups.push(
    () => disposeOwnedCustody(ownerA),
    () => disposeOwnedCustody(ownerB)
  );
  const captureA = readOwnedProjection(ownerA),
    captureB = readOwnedProjection(ownerB);
  expect(captureA.epoch).toBe(captureB.epoch);
  expect(captureA.subject).toBeUndefined();
  expect(captureB.subject).toBeUndefined();
  expect(ownedProjectionCurrent(ownerA, captureA)).toBe(true);
  expect(ownedProjectionCurrent(ownerB, captureB)).toBe(true);
  expect(ownedProjectionCurrent(ownerA, captureB)).toBe(false);
  expect(ownedProjectionCurrent(ownerB, captureA)).toBe(false);
  expect(dispatchA).not.toHaveBeenCalled();
  expect(dispatchB).not.toHaveBeenCalled();
  expect(transportA.getCanvasChannel).not.toHaveBeenCalled();
  expect(transportB.getCanvasChannel).not.toHaveBeenCalled();
  vi.mocked(transportA.getCanvasChannel).mockResolvedValue(response());
  const run = createOwnedReplayRun(ownerA),
    page = await run.readPage();
  expect(run.consumePage(page!)).toEqual({ kind: 'frames', count: 0 });
  expect(run.finishPage(page!)).toBe('done');
  expect(ownedProjectionCurrent(ownerA, captureA)).toBe(false);
  const issuedCapture = readOwnedProjection(ownerA);
  expect(issuedCapture.subject).toBeDefined();
  expect(ownedProjectionCurrent(ownerA, issuedCapture)).toBe(true);
  expect(ownedProjectionCurrent(ownerB, issuedCapture)).toBe(false);
});
it('consumes only the genuine constructor ticket and refuses second lifecycle construction', () => {
  const transport = createMockTransport(),
    dispatch = vi.fn();
  const custodyKey = createOwnedCustody('doc', transport, dispatch);
  createOwnedReplayLifetime(custodyKey);
  createOwnedFrameFacade(custodyKey);
  cleanups.push(() => disposeOwnedCustody(custodyKey));
  expect(() => requireOwnedCustody(custodyKey)).not.toThrow();
  expect(() => consumeOwnedConstruction(custodyKey)).toThrow('foreign or consumed');
  expect(() => buildOwnedLifecycle(custodyKey)).toThrow('foreign or consumed');
  expect(() => consumeOwnedConstruction({})).toThrow('foreign or consumed');
  expect(() => buildOwnedLifecycle(transport)).toThrow('foreign or consumed');
  expect(ownedProjectionCurrent(custodyKey, readOwnedProjection(custodyKey))).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
  expect(transport.getCanvasChannel).not.toHaveBeenCalled();
});

async function liveRouting(
  first?: (
    notification: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelNotification
  ) => void
) {
  const transport = createMockTransport();
  if (first) cleanups.push(subscribeDocChannelNotifications(undefined, first, transport));
  let view = emptyDocChannelView('doc', transport);
  const owner = createDocChannelOwner('doc', transport, (update) => {
    view = typeof update === 'function' ? update(view) : update;
  });
  cleanups.push(owner.dispose);
  owner.start(() => {});
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(response());
  const run = owner.beginRun(),
    page = await run.readPage();
  expect(run.consumePage(page!)).toEqual({ kind: 'frames', count: 0 });
  expect(run.finishPage(page!)).toBe('done');
  const controller = new AbortController();
  const producer = ownDocChannelConnection(transport, controller.signal);
  cleanups.push(producer.retire);
  const publish = (routing: ReturnType<typeof response>['routing'] | undefined) => {
    const { events: _events, routing: _routing, ...snapshot } = response();
    return producer.publish({
      type: 'canvas_channel_snapshot',
      documentId: 'doc',
      scope: 'session:one',
      snapshot: { ...snapshot, ...(routing ? { routing } : {}) },
    });
  };
  return {
    transport,
    publish,
    retire: producer.retire,
    get view() {
      return view;
    },
  };
}
it('detaches same-birth disabled routing from caller data and exposed projection envelopes', async () => {
  const h = await liveRouting();
  const disabled = { enabled: false, destinationLabel: 'Disabled', approvedEventTypes: ['save'] };
  expect(h.publish(disabled)).toBe(true);
  const binding = h.view.binding!;
  expect(binding.current('submit')).toBe(false);
  disabled.enabled = true;
  expect(() => {
    h.view.snapshot!.routing!.enabled = true;
  }).toThrow();
  expect(() => {
    h.view.snapshot!.routing!.approvedEventTypes.push('forged');
  }).toThrow();
  expect(() => {
    h.view.snapshot!.routing = response().routing;
  }).toThrow();
  expect(binding.current('submit')).toBe(false);
  expect(binding.captureOriginal!(event)).toBeNull();
  await expect(binding.submit(event, new AbortController().signal)).rejects.toThrow();
  expect(h.transport.ingestCanvasEvent).not.toHaveBeenCalled();
  expect(h.publish(response().routing)).toBe(true);
  expect(h.view.binding!.current('submit')).toBe(true);
  vi.mocked(h.transport.ingestCanvasEvent).mockResolvedValue(accepted);
  const signal = new AbortController().signal;
  expect(await h.view.binding!.submit(event, signal)).toEqual(accepted);
  expect(h.transport.ingestCanvasEvent).toHaveBeenCalledWith(
    'doc',
    event,
    { expectedGeneration: birth.generation },
    signal
  );
});
it('freezes genuine parsed routing before an earlier subscriber can change a later owner’s eligibility', async () => {
  let failures = 0;
  const h = await liveRouting((notification) => {
    if (notification.type !== 'canvas_channel_snapshot' || !notification.snapshot.routing) return;
    try {
      notification.snapshot.routing.enabled = true;
    } catch {
      failures++;
    }
    try {
      notification.snapshot.routing.approvedEventTypes.push('forged');
    } catch {
      failures++;
    }
  });
  expect(
    h.publish({ enabled: false, destinationLabel: 'Disabled', approvedEventTypes: ['save'] })
  ).toBe(true);
  expect(failures).toBe(2);
  expect(h.view.snapshot!.routing).toEqual({
    enabled: false,
    destinationLabel: 'Disabled',
    approvedEventTypes: ['save'],
  });
  expect(h.view.binding!.current('submit')).toBe(false);
  expect(h.view.binding!.captureOriginal!(event)).toBeNull();
  await expect(h.view.binding!.submit(event, new AbortController().signal)).rejects.toThrow();
  expect(h.transport.ingestCanvasEvent).not.toHaveBeenCalled();
});
it('keeps absent genuine routing unavailable rather than accepting a public enabled replacement', async () => {
  const h = await liveRouting();
  expect(h.publish(undefined)).toBe(true);
  expect(h.view.snapshot!.routing).toBeUndefined();
  expect(h.view.binding!.current('submit')).toBe(false);
  expect(() => {
    h.view.snapshot!.routing = response().routing;
  }).toThrow();
  expect(h.view.binding!.captureOriginal!(event)).toBeNull();
  expect(h.transport.ingestCanvasEvent).not.toHaveBeenCalled();
});

it.each(['mutation', 'error', 'undefined'] as const)(
  'delivers genuine disabled routing after an earlier uncaught %s observer failure',
  async (failure) => {
    const h = await liveRouting((notification) => {
      if (notification.type !== 'canvas_channel_snapshot') return;
      if (failure === 'mutation') notification.snapshot.routing!.enabled = true;
      else if (failure === 'error') throw new Error('earlier observer failed');
      else throw undefined;
    });
    expect(h.view.binding!.current('submit')).toBe(true);
    expect(
      h.publish({ enabled: false, destinationLabel: 'Disabled', approvedEventTypes: ['save'] })
    ).toBe(true);
    expect(h.view.snapshot!.routing).toEqual({
      enabled: false,
      destinationLabel: 'Disabled',
      approvedEventTypes: ['save'],
    });
    const binding = h.view.binding!;
    expect(binding.current('submit')).toBe(false);
    expect(binding.captureOriginal!(event)).toBeNull();
    await expect(binding.submit(event, new AbortController().signal)).rejects.toThrow();
    expect(h.transport.ingestCanvasEvent).not.toHaveBeenCalled();
  }
);
it.each(['error', 'undefined'] as const)(
  'stops later notification delivery when an earlier observer retires the producer then throws %s',
  async (failure) => {
    const h = await liveRouting((notification) => {
      if (notification.type !== 'canvas_channel_snapshot') return;
      retire();
      if (failure === 'error') throw new Error('retired earlier observer');
      throw undefined;
    });
    const retire = h.retire;
    const binding = h.view.binding!;
    expect(binding.current('submit')).toBe(true);
    const later = vi.fn();
    cleanups.push(subscribeDocChannelNotifications(undefined, later, h.transport));
    expect(
      h.publish({ enabled: false, destinationLabel: 'Disabled', approvedEventTypes: ['save'] })
    ).toBe(false);
    expect(later).not.toHaveBeenCalled();
    expect(binding.current('submit')).toBe(false);
    expect(binding.captureOriginal!(event)).toBeNull();
    await expect(binding.submit(event, new AbortController().signal)).rejects.toThrow();
    expect(h.transport.ingestCanvasEvent).not.toHaveBeenCalled();
  }
);

it.each(['error', 'undefined'] as const)(
  'returns false when the last selected observer retires its producer then throws %s',
  async (failure) => {
    const h = await liveRouting();
    const binding = h.view.binding!;
    expect(binding.current('submit')).toBe(true);
    cleanups.push(
      subscribeDocChannelNotifications(
        undefined,
        () => {
          h.retire();
          if (failure === 'error') throw new Error('last selected observer retired');
          throw undefined;
        },
        h.transport
      )
    );
    expect(
      h.publish({ enabled: false, destinationLabel: 'Disabled', approvedEventTypes: ['save'] })
    ).toBe(false);
    expect(binding.current('submit')).toBe(false);
    expect(binding.captureOriginal!(event)).toBeNull();
    await expect(binding.submit(event, new AbortController().signal)).rejects.toThrow();
    expect(h.transport.ingestCanvasEvent).not.toHaveBeenCalled();
  }
);
