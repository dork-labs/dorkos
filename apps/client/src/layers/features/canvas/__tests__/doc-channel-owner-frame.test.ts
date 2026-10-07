/** @vitest-environment jsdom */
/** Proposed exact captured frame retirement controls. UNRUN. */
import { afterEach, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import { FrameLifetimeController } from '@/layers/shared/lib/canvas-doc-frame';
import { createDocChannelOwner } from '../model/doc-channel-owner';
import { emptyDocChannelView } from '../model/doc-channel-view';
import {
  readOwnedFrameFacade,
  captureOwnedFrameRetirement,
  consumeOwnedFrameRetirement,
} from '../model/doc-channel-owner-frame';
import { DocChannelFrameResources } from '../model/doc-channel-frame-resources';
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
async function owned(routed = true) {
  const transport = createMockTransport();
  vi.mocked(transport.getCanvasChannel).mockResolvedValue({
    ...response(),
    routing: { ...response().routing, enabled: routed },
  });
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
it('refuses structural owner tokens and consumes captured retirement tickets only once', async () => {
  expect(() => readOwnedFrameFacade({})).toThrow();
  const h = await owned();
  const facade = h.view.frameAdmission!,
    subscriber = vi.fn();
  facade.subscribeInvalidation(subscriber);
  expect(() => captureOwnedFrameRetirement(h.owner)).toThrow();
  expect(() => consumeOwnedFrameRetirement(h.owner, {})).toThrow();
  expect(subscriber).not.toHaveBeenCalled();
  h.owner.dispose();
  h.owner.dispose();
  expect(subscriber).toHaveBeenCalledTimes(1);
});
it('requires pre-navigation custody and rejects an unknown already-loaded frame', async () => {
  const h = await owned(),
    f = host(h.transport),
    facade = h.view.frameAdmission!;
  const unknown = f.controller.observeLoaded(f.observation)!;
  expect(facade.prepareFrameLoad(f.controller, unknown)).toBeNull();
  expect(facade.attachFrame(f.controller, unknown)).toBeNull();
});
it('does not let an OLD resource ticket drain a nested winning cleanup', () => {
  const resources = new DocChannelFrameResources();
  const oldCleanup = vi.fn(),
    nestedCleanup = vi.fn();
  const first = resources.begin();
  resources.install(first, oldCleanup);
  let nested = 0;
  resources.subscribe(() => {
    nested = resources.begin();
    resources.install(nested, nestedCleanup);
  });
  const ticket = resources.captureRetirement();
  resources.drainRetirement(ticket);
  expect(oldCleanup).toHaveBeenCalledTimes(1);
  expect(nestedCleanup).not.toHaveBeenCalled();
  expect(resources.current(nested)).toBe(true);
  expect(() => resources.drainRetirement(ticket)).toThrow();
  expect(nestedCleanup).not.toHaveBeenCalled();
});
it('drains independent OLD resources after an undefined throw without touching a nested winner', () => {
  const resources = new DocChannelFrameResources(),
    cleanup = vi.fn(),
    sibling = vi.fn();
  const first = resources.begin();
  resources.install(first, cleanup);
  resources.subscribe(() => {
    throw undefined;
  });
  resources.subscribe(sibling);
  const ticket = resources.captureRetirement();
  expect(() => resources.drainRetirement(ticket)).not.toThrow();
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(sibling).toHaveBeenCalledTimes(1);
});

it('records through an actual captured frame without routing and keeps ordinary widget submission refused', async () => {
  const h = await owned(false),
    f = host(h.transport),
    facade = h.view.frameAdmission!;
  expect(h.view.binding!.current('submit')).toBe(false);
  const prepared = facade.prepareFrameLoad(f.controller, f.observation);
  expect(prepared).not.toBeNull();
  const loaded = prepared!.completeLoad();
  expect(loaded).not.toBeNull();
  const port = facade.attachFrame(f.controller, loaded!);
  expect(port).not.toBeNull();
  const event = {
    v: 1,
    id: '00000000-0000-4000-8000-000000000001',
    type: 'save',
    payload: { text: 'log only' },
  };
  const receipt = {
    receipt: { id: event.id, status: 'recorded' as const, docSeq: 1 },
    deliveries: [],
  };
  vi.mocked(h.transport.ingestCanvasEvent).mockResolvedValue(receipt);
  const original = port!.captureOriginal({ id: event.id, bytes: JSON.stringify(event) });
  expect(original).not.toBeNull();
  await expect(original!.submit(new AbortController().signal)).resolves.toEqual({
    kind: 'accepted',
    receipt,
  });
  expect(h.transport.ingestCanvasEvent).toHaveBeenCalledExactlyOnceWith(
    'doc',
    event,
    { expectedGeneration: birth.generation },
    expect.any(AbortSignal)
  );
  expect(h.view.binding!.current('submit')).toBe(false);
  f.controller.retire();
  expect(port!.current()).toBe(false);
});

it('keeps native server refusal and retirement on the original log-only frame', async () => {
  const h = await owned(false),
    f = host(h.transport),
    facade = h.view.frameAdmission!;
  const loaded = facade.prepareFrameLoad(f.controller, f.observation)!.completeLoad()!;
  const port = facade.attachFrame(f.controller, loaded)!;
  const event = { v: 1, id: '00000000-0000-4000-8000-000000000002', type: 'save', payload: {} };
  vi.mocked(h.transport.ingestCanvasEvent).mockRejectedValue(
    Object.assign(new Error('Access refused'), { status: 403 })
  );
  const original = port.captureOriginal({ id: event.id, bytes: JSON.stringify(event) })!;
  await expect(original.submit(new AbortController().signal)).resolves.toEqual({
    kind: 'uncertain',
  });
  expect(h.transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
  h.owner.dispose();
  expect(() => port.captureOriginal({ id: event.id, bytes: JSON.stringify(event) })).toThrow();
  expect(h.transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
});

it('rebinds only the exact original loaded observation after same-birth owned HTTP recovery', async () => {
  const h = await owned(),
    f = host(h.transport),
    facade = h.view.frameAdmission!;
  const loaded = facade.prepareFrameLoad(f.controller, f.observation)!.completeLoad()!;
  const oldPort = facade.attachFrame(f.controller, loaded)!;
  expect(oldPort.current()).toBe(true);
  const failedRun = h.owner.beginRun();
  failedRun.failed();
  expect(h.view.binding!.current('read')).toBe(false);
  expect(oldPort.current()).toBe(false);
  expect(facade.retainsLoadedFrame(f.controller, loaded)).toBe(true);
  // Retire Doc authority while preserving the original positively observed host load.
  f.controller.disableDoc();
  expect(f.controller.getCurrent()).toBe(loaded);
  const recovered = h.owner.beginRun(),
    page = await recovered.readPage();
  expect(recovered.consumePage(page!)).toEqual({ kind: 'frames', count: 0 });
  expect(recovered.finishPage(page!)).toBe('done');
  expect(h.view.frameAdmission).toBe(facade);
  expect(h.view.binding!.current('read')).toBe(true);
  const renewed = facade.attachFrame(f.controller, loaded);
  expect(renewed).not.toBeNull();
  expect(renewed!.current()).toBe(true);
  expect(oldPort.current()).toBe(false);
  expect(f.controller.getCurrent()).toBe(loaded);
  f.controller.retire();
  expect(renewed!.current()).toBe(false);
  expect(facade.attachFrame(f.controller, loaded)).toBeNull();
  expect(facade.retainsLoadedFrame(f.controller, loaded)).toBe(false);
});

it('does not renew the retained host load when owned HTTP recovery observes a different birth', async () => {
  const h = await owned(),
    f = host(h.transport),
    facade = h.view.frameAdmission!;
  const loaded = facade.prepareFrameLoad(f.controller, f.observation)!.completeLoad()!;
  const oldPort = facade.attachFrame(f.controller, loaded)!;
  const failedRun = h.owner.beginRun();
  failedRun.failed();
  f.controller.disableDoc();
  vi.mocked(h.transport.getCanvasChannel).mockResolvedValue({
    ...response(),
    incarnation: { ...birth, generation: 'b'.repeat(64), physicalOpenedAt: '2026-10-03T00:00:00Z' },
  });
  const recovered = h.owner.beginRun(),
    page = await recovered.readPage();
  expect(recovered.consumePage(page!)).toEqual({ kind: 'done' });
  const nextBirth = h.owner.beginRun(),
    nextPage = await nextBirth.readPage();
  expect(nextBirth.consumePage(nextPage!)).toEqual({ kind: 'frames', count: 0 });
  expect(nextBirth.finishPage(nextPage!)).toBe('done');
  expect(h.view.binding!.current('read')).toBe(true);
  expect(oldPort.current()).toBe(false);
  expect(facade.retainsLoadedFrame(f.controller, loaded)).toBe(false);
  expect(facade.attachFrame(f.controller, loaded)).toBeNull();
  expect(f.controller.getCurrent()).toBe(loaded);
  f.controller.retire();
});
