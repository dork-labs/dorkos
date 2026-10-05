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
