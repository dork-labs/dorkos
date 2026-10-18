/** @vitest-environment jsdom */
// Genuine host-hook composition; mock HTTP replay is unit input, never server acceptance.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockTransport } from '@dorkos/test-utils';
import type { CanvasChannelReplayResponse } from '@dorkos/shared/canvas-channel-schemas';
import { DocFrameHandshake, FrameLifetimeController } from '@/layers/shared/lib/canvas-doc-frame';
const transport = createMockTransport();
let currentTransport = transport;
const state = {
  openDocuments: [],
  selectedCwd: '/work',
  roomCanvasLiveRoomId: null,
  roomCanvasEditing: {},
  browserHistories: {},
  writeBrowserHistory: vi.fn(),
};
vi.mock('@/layers/shared/model', () => {
  const useAppStore = (select: (value: typeof state) => unknown) => select(state);
  useAppStore.getState = () => state;
  return { useAppStore, useTransport: () => currentTransport, useSafeSearch: () => ({}) };
});
vi.mock('../lib/probe-direct', () => ({ probeDirect: async () => true }));
import { CanvasBrowserContent } from '../ui/CanvasBrowserContent';
const birth = {
  v: 1 as const,
  documentId: 'doc',
  physicalOpenedAt: '2026-10-02T00:00:00Z',
  channelCreatedAt: '2026-10-02T00:00:01Z',
  generation: 'a'.repeat(64),
};
const replay = (routingEnabled = true): CanvasChannelReplayResponse => ({
  incarnation: birth,
  events: [],
  state: {},
  stateRev: 0,
  highWatermark: 0,
  retentionFloor: 1,
  receiptRetentionFloor: 1,
  resetRequired: false,
  receipts: [],
  health: { status: 'ready', reasons: [] },
  routing: {
    enabled: routingEnabled,
    approvedEventTypes: routingEnabled ? ['doc.saved'] : [],
    destinationLabel: routingEnabled ? 'Approved route' : 'No routes',
  },
});
const started = () =>
  vi.mocked(DocFrameHandshake.prototype.start).mock.contexts as DocFrameHandshake[];
const OFFLINE = 'Page is offline. Reload to reconnect.';
beforeEach(() => {
  currentTransport = transport;
  vi.mocked(transport.createServeUrl)
    .mockReset()
    .mockResolvedValue('/api/workbench/serve/unit-token/preview.html');
  vi.mocked(transport.getCanvasChannel).mockReset().mockResolvedValue(replay());
  state.browserHistories = {};
  state.writeBrowserHistory.mockClear();
  vi.spyOn(DocFrameHandshake.prototype, 'start');
  vi.spyOn(DocFrameHandshake.prototype, 'receive').mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
/** The page answers the newest challenge, as the injected SDK would. */
function acknowledge() {
  vi.mocked(DocFrameHandshake.prototype.receive).mockImplementation(function (
    this: DocFrameHandshake
  ) {
    return this === started().at(-1);
  });
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: 'ack' }));
  });
}
async function servedFrame() {
  render(
    <CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: 'preview.html' }} />
  );
  const frame = (await screen.findByTitle('Embedded browser')) as HTMLIFrameElement;
  await waitFor(() =>
    expect(frame.getAttribute('src')).toBe('/api/workbench/serve/unit-token/preview.html')
  );
  return frame;
}

it('a served page loads straight away and is offered a port only once it has loaded', async () => {
  const observe = vi.spyOn(FrameLifetimeController.prototype, 'observeHostContext');
  const frame = await servedFrame();
  // Opaque origin: the page can never call the API as the person.
  expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  expect(observe).not.toHaveBeenCalled();
  fireEvent.load(frame);
  await waitFor(() => expect(started()).toHaveLength(1));
  // Identity, never deep equality: a jsdom Window is an endless graph to walk.
  expect(observe.mock.calls[0][0].frame === frame.contentWindow).toBe(true);
  expect(observe.mock.calls[0][0]).toMatchObject({
    documentId: 'doc',
    eligibility: 'served-document',
    exactOrigin: 'null',
  });
});

// A route to the agent itself is granted with no person, so an outside page
// must never reach the document, even by posting a handshake it guessed.
it.each(['url', 'browser'] as const)(
  'an outside %s doc is a plain page: no challenge, and a well-formed answer gets no port',
  async (type) => {
    vi.mocked(DocFrameHandshake.prototype.receive).mockRestore();
    const observe = vi.spyOn(FrameLifetimeController.prototype, 'observeHostContext');
    render(
      <CanvasBrowserContent documentId="doc" content={{ type, url: 'https://example.com/' }} />
    );
    const frame = (await screen.findByTitle('Embedded browser')) as HTMLIFrameElement;
    await waitFor(() => expect(frame.getAttribute('src')).toBe('https://example.com/'));
    const page = frame.contentWindow!;
    const posts = vi.spyOn(page, 'postMessage');
    fireEvent.load(frame);
    await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalled());
    await act(async () => {});
    for (const origin of ['https://example.com', 'null'])
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source: page,
            origin,
            data: {
              protocol: 'dorkos-doc',
              v: 1,
              kind: 'ack',
              nonce: 'guessed-nonce',
              requestToken: 'guessed-token',
              loadToken: 1,
              generation: birth.generation,
            },
          })
        );
      });
    await act(async () => {});
    expect(observe).not.toHaveBeenCalled();
    expect(started()).toHaveLength(0);
    expect(posts).not.toHaveBeenCalled();
  }
);

it('a page with no approved route yet shows no offline notice', async () => {
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay(false));
  const frame = await servedFrame();
  fireEvent.load(frame);
  await act(async () => {});
  expect(started()).toHaveLength(0);
  expect(screen.queryByText(OFFLINE)).toBeNull();
});

it('a connected page that stops answering says so, and Reload brings back a fresh frame', async () => {
  const frame = await servedFrame();
  fireEvent.load(frame);
  await waitFor(() => expect(started()).toHaveLength(1));
  acknowledge();
  // The page navigates itself somewhere that never answers the new challenge.
  fireEvent.load(frame);
  await waitFor(() => expect(started()).toHaveLength(2));
  act(() => started()[1].close());
  expect(screen.getByText(OFFLINE)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(screen.getByTitle('Embedded browser')).not.toBe(frame));
  expect(screen.queryByText(OFFLINE)).toBeNull();
  fireEvent.load(screen.getByTitle('Embedded browser'));
  await waitFor(() => expect(started()).toHaveLength(3));
});

it('a slow-load notice is cleared by the page actually loading', async () => {
  let deadline: (() => void) | undefined;
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    if (delay === 10_000 && typeof callback === 'function') deadline = callback as () => void;
    return schedule(callback, delay, ...args);
  });
  const frame = await servedFrame();
  fireEvent.load(frame);
  expect(deadline).toBeDefined();
  act(() => deadline!());
  expect(screen.queryByText('This preview is slow to load.')).toBeNull();
});
