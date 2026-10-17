/** @vitest-environment jsdom */
// Genuine host-hook composition; mock HTTP replay is unit input, never server acceptance.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Suspense } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockTransport } from '@dorkos/test-utils';
import type { CanvasChannelReplayResponse } from '@dorkos/shared/canvas-channel-schemas';
import { FrameLifetimeController } from '@/layers/shared/lib/canvas-doc-frame';
import { ownDocChannelConnection } from '@/layers/shared/lib/transport/doc-channel-ownership';
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
function observePhysicalFrames() {
  const matches: boolean[] = [];
  const original = FrameLifetimeController.prototype.observeHostContext;
  const observe = vi.spyOn(FrameLifetimeController.prototype, 'observeHostContext');
  observe.mockImplementation(function (this: FrameLifetimeController, input) {
    const element = screen.queryByTitle('Embedded browser') as HTMLIFrameElement | null;
    matches.push(!!element?.isConnected && input.frame === element.contentWindow);
    return original.call(this, input);
  });
  return { observe, matches };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  currentTransport = transport;
  vi.mocked(transport.createServeUrl)
    .mockReset()
    .mockResolvedValue('/api/workbench/serve/unit-token/preview.html');
  vi.mocked(transport.getCanvasChannel).mockReset().mockResolvedValue(replay());
  state.browserHistories = {};
  state.writeBrowserHistory.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('the real browser viewer captures its actual fresh node only after initial replay settles', async () => {
  const page = deferred<CanvasChannelReplayResponse>();
  vi.mocked(transport.getCanvasChannel).mockReturnValue(page.promise);
  const { observe, matches } = observePhysicalFrames();
  const loaded = vi.spyOn(FrameLifetimeController.prototype, 'observeLoaded');
  render(
    <CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: 'preview.html' }} />
  );
  const frame = (await screen.findByTitle('Embedded browser')) as HTMLIFrameElement;
  expect(frame.getAttribute('src')).toBe('about:blank');
  expect(observe).not.toHaveBeenCalled();
  await act(async () => page.resolve(replay()));
  await waitFor(() =>
    expect(frame.getAttribute('src')).toBe('/api/workbench/serve/unit-token/preview.html')
  );
  expect(observe).toHaveBeenCalledTimes(1);
  expect(matches).toEqual([true]);
  expect(observe.mock.calls[0][0].documentId).toBe('doc');
  expect(observe.mock.calls[0][0].transportOwner === transport).toBe(true);
  expect(observe.mock.calls[0][0].eligibility).toBe('served-document');
  expect(observe.mock.calls[0][0].exactOrigin).toBe('null');
  expect(loaded).not.toHaveBeenCalled();
  expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
});
it('external browser presentation does not capture or acquire a Doc frame lease', async () => {
  const observe = vi.spyOn(FrameLifetimeController.prototype, 'observeHostContext');
  const acquire = vi.spyOn(FrameLifetimeController.prototype, 'acquireDoc');
  render(
    <CanvasBrowserContent
      documentId="doc"
      content={{ type: 'browser', url: 'https://external.example/' }}
    />
  );
  const frame = await screen.findByTitle('Embedded browser');
  await waitFor(() => expect(frame.getAttribute('src')).toBe('https://external.example/'));
  expect(observe).not.toHaveBeenCalled();
  expect(acquire).not.toHaveBeenCalled();
});

it('a queued initial blank load cannot dismiss the actual preview load deadline', async () => {
  let deadline: (() => void) | undefined;
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    if (delay === 10_000 && typeof callback === 'function') deadline = callback as () => void;
    return schedule(callback, delay, ...args);
  });
  const pendingReplay = deferred<CanvasChannelReplayResponse>();
  vi.mocked(transport.getCanvasChannel).mockReturnValue(pendingReplay.promise);
  render(
    <CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: 'preview.html' }} />
  );
  const frame = (await screen.findByTitle('Embedded browser')) as HTMLIFrameElement;
  const blankDocument = frame.contentDocument;
  expect(blankDocument?.URL).toBe('about:blank');
  const original = Object.getOwnPropertyDescriptor(frame, 'contentDocument');
  // Model delivery of this actual initial document's queued load after src assignment.
  // This host-readable blank input must be rejected, not used as a completed-load witness.
  Object.defineProperty(frame, 'contentDocument', { configurable: true, get: () => blankDocument });
  try {
    await act(async () => {
      pendingReplay.resolve(replay());
      await pendingReplay.promise;
    });
    expect(frame.getAttribute('src')).toBe('/api/workbench/serve/unit-token/preview.html');
    fireEvent.load(frame);
    expect(deadline).toBeDefined();
    act(() => deadline!());
    expect(screen.getByText('This preview is slow to load.')).toBeTruthy();
  } finally {
    if (original) Object.defineProperty(frame, 'contentDocument', original);
    else Reflect.deleteProperty(frame, 'contentDocument');
  }
});
it('Suspense reveal retains the old page offline until explicit Reload captures a fresh node', async () => {
  const gate = deferred<void>();
  function Retained({ hidden }: { hidden: boolean }) {
    if (hidden) throw gate.promise;
    return (
      <CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: 'preview.html' }} />
    );
  }
  const { observe, matches } = observePhysicalFrames();
  const tree = (hidden: boolean) => (
    <Suspense fallback={<p>Temporarily hidden</p>}>
      <Retained hidden={hidden} />
    </Suspense>
  );
  const host = render(tree(false));
  const frame = (await screen.findByTitle('Embedded browser')) as HTMLIFrameElement;
  await waitFor(() => expect(frame.getAttribute('src')).not.toBe('about:blank'));
  expect(observe).toHaveBeenCalledTimes(1);
  frame.dataset.localPageState = 'retained';
  host.rerender(tree(true));
  expect(screen.getByText('Temporarily hidden')).toBeTruthy();
  expect(frame.isConnected).toBe(true);
  host.rerender(tree(false));
  await act(async () => {
    gate.resolve();
    await gate.promise;
  });
  expect(screen.getByTitle('Embedded browser')).toBe(frame);
  expect(frame.dataset.localPageState).toBe('retained');
  expect(screen.getByText('Page is offline. Reload to reconnect.')).toBeTruthy();
  expect(observe).toHaveBeenCalledTimes(1);
  // Even a late load from this old element cannot become the new owner's capture.
  fireEvent.load(frame);
  expect(observe).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(screen.getByTitle('Embedded browser')).not.toBe(frame));
  const fresh = screen.getByTitle('Embedded browser') as HTMLIFrameElement;
  await waitFor(() => expect(fresh.getAttribute('src')).not.toBe('about:blank'));
  expect(observe).toHaveBeenCalledTimes(2);
  expect(matches).toEqual([true, true]);
  expect(screen.queryByText('Page is offline. Reload to reconnect.')).toBeNull();
});

it('retiring an old URL capture does not label the newly admitted URL offline', async () => {
  render(
    <CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: 'preview.html' }} />
  );
  const old = await screen.findByTitle('Embedded browser');
  await waitFor(() => expect(old.getAttribute('src')).not.toBe('about:blank'));
  vi.mocked(transport.createServeUrl).mockResolvedValue('/api/workbench/serve/new-token/next.html');
  fireEvent.click(screen.getByRole('button', { name: /^Address:/ }));
  const address = screen.getByRole('textbox', { name: 'Address' });
  fireEvent.change(address, { target: { value: './next.html' } });
  fireEvent.submit(address.closest('form')!);
  await waitFor(() => expect(screen.getByTitle('Embedded browser')).not.toBe(old));
  await waitFor(() =>
    expect(screen.getByTitle('Embedded browser').getAttribute('src')).toBe(
      '/api/workbench/serve/new-token/next.html'
    )
  );
  expect(screen.queryByText('Page is offline. Reload to reconnect.')).toBeNull();
});
it('same-URL Transport replacement captures a new node without inheriting the retired offline banner', async () => {
  const gate = deferred<void>();
  function Retained({ hidden }: { hidden: boolean }) {
    if (hidden) throw gate.promise;
    return (
      <CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: 'preview.html' }} />
    );
  }
  const tree = (hidden: boolean) => (
    <Suspense fallback={<p>Hidden for transport test</p>}>
      <Retained hidden={hidden} />
    </Suspense>
  );
  const { observe, matches } = observePhysicalFrames();
  const host = render(tree(false));
  const old = await screen.findByTitle('Embedded browser');
  await waitFor(() => expect(old.getAttribute('src')).not.toBe('about:blank'));
  host.rerender(tree(true));
  expect(screen.getByText('Hidden for transport test')).toBeTruthy();
  host.rerender(tree(false));
  await act(async () => {
    gate.resolve();
    await gate.promise;
  });
  expect(screen.getByText('Page is offline. Reload to reconnect.')).toBeTruthy();
  const next = createMockTransport();
  vi.mocked(next.createServeUrl).mockResolvedValue('/api/workbench/serve/unit-token/preview.html');
  vi.mocked(next.getCanvasChannel).mockResolvedValue(replay());
  currentTransport = next;
  host.rerender(tree(false));
  await waitFor(() => expect(screen.getByTitle('Embedded browser')).not.toBe(old));
  const fresh = screen.getByTitle('Embedded browser') as HTMLIFrameElement;
  await waitFor(() => expect(fresh.getAttribute('src')).not.toBe('about:blank'));
  expect(matches).toEqual([true, true]);
  expect(observe.mock.calls.at(-1)?.[0].transportOwner === next).toBe(true);
  expect(screen.queryByText('Page is offline. Reload to reconnect.')).toBeNull();
});

it('routing-disabled local pages display offline and cannot acquire a Doc port', async () => {
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay(false));
  const observe = vi.spyOn(FrameLifetimeController.prototype, 'observeHostContext');
  const loaded = vi.spyOn(FrameLifetimeController.prototype, 'observeLoaded');
  const acquire = vi.spyOn(FrameLifetimeController.prototype, 'acquireDoc');
  render(
    <CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: 'preview.html' }} />
  );
  const frame = (await screen.findByTitle('Embedded browser')) as HTMLIFrameElement;
  await waitFor(() =>
    expect(frame.getAttribute('src')).toBe('/api/workbench/serve/unit-token/preview.html')
  );
  expect(screen.getByText('Page is offline. Reload to reconnect.')).toBeTruthy();
  fireEvent.load(frame);
  expect(observe).not.toHaveBeenCalled();
  expect(loaded).not.toHaveBeenCalled();
  expect(acquire).not.toHaveBeenCalled();
});
it('enabling routing cannot retrofit a Doc capture onto the already displayed offline page', async () => {
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay(false));
  const { observe, matches } = observePhysicalFrames();
  const acquire = vi.spyOn(FrameLifetimeController.prototype, 'acquireDoc');
  const connection = ownDocChannelConnection(transport, new AbortController().signal);
  try {
    render(
      <CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: 'preview.html' }} />
    );
    const frame = (await screen.findByTitle('Embedded browser')) as HTMLIFrameElement;
    await waitFor(() => expect(frame.getAttribute('src')).not.toBe('about:blank'));
    const { events, ...snapshot } = replay(true);
    expect(events).toEqual([]);
    await act(async () => {
      expect(
        connection.publish({
          type: 'canvas_channel_snapshot',
          documentId: 'doc',
          scope: 'session-a',
          snapshot,
        })
      ).toBe(true);
    });
    fireEvent.load(frame);
    expect(screen.getByTitle('Embedded browser')).toBe(frame);
    expect(observe).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(screen.getByText('Page is offline. Reload to reconnect.')).toBeTruthy();
    vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay(true));
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.getByTitle('Embedded browser')).not.toBe(frame));
    await waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
    expect(matches).toEqual([true]);
    expect(screen.queryByText('Page is offline. Reload to reconnect.')).toBeNull();
  } finally {
    connection.retire();
  }
});
