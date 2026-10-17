/** @vitest-environment jsdom */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { FrameLifetimeController } from '@/layers/shared/lib/canvas-doc-frame';
import type { CanvasChannelReplayResponse } from '@dorkos/shared/canvas-channel-schemas';
import { useDocFrameChannel, type DocFrameMountParams } from '../model/use-doc-frame-channel';
const birth = {
  v: 1 as const,
  documentId: 'frame-doc',
  physicalOpenedAt: '2026-10-02T00:00:00Z',
  channelCreatedAt: '2026-10-02T00:00:01Z',
  generation: 'a'.repeat(64),
};
const replay = (): CanvasChannelReplayResponse => ({
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
  routing: { enabled: true, destinationLabel: 'Tasks', approvedEventTypes: ['save'] },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function Host({
  nonce = 0,
  bridgeEligibility = 'served-document',
  retireWhileBlank = false,
  exposeRetirement,
}: {
  nonce?: number;
  bridgeEligibility?: DocFrameMountParams['bridgeEligibility'];
  retireWhileBlank?: boolean;
  exposeRetirement?: (retire: (frame?: Window) => void) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frame = useDocFrameChannel({
    freshPhysicalFrame: true,
    iframeRef,
    documentId: 'frame-doc',
    logicalUrl: 'frame.html',
    reloadNonce: nonce,
    resolvedSource: '/served/frame.html',
    bridgeEligibility,
    previewOrigin: null,
  });
  const { noteFrameMounted, noteFrameRetired } = frame;
  useLayoutEffect(() => {
    exposeRetirement?.(noteFrameRetired);
  }, [exposeRetirement, noteFrameRetired]);
  useEffect(() => {
    if (retireWhileBlank && iframeRef.current?.getAttribute('src') === 'about:blank')
      noteFrameRetired();
  });
  const mounted = useCallback(
    (element: HTMLIFrameElement | null) => {
      iframeRef.current = element;
      noteFrameMounted(element);
    },
    [noteFrameMounted]
  );
  return (
    <iframe
      key={frame.physicalMountKey}
      ref={mounted}
      src={frame.navigationSource ?? 'about:blank'}
      title="actual owned frame"
      data-requires-reload={frame.requiresReload ? 'yes' : 'no'}
      onLoad={(event) => frame.noteFrameLoaded(event.currentTarget)}
    />
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('waits for genuine owned HTTP replay before capturing the fresh physical node and assigning real source', async () => {
  const transport = createMockTransport(),
    pending = deferred<CanvasChannelReplayResponse>();
  vi.mocked(transport.getCanvasChannel).mockReturnValue(pending.promise);
  const observe = vi.spyOn(FrameLifetimeController.prototype, 'observeHostContext');
  const loaded = vi.spyOn(FrameLifetimeController.prototype, 'observeLoaded');
  render(
    <TransportProvider transport={transport}>
      <Host />
    </TransportProvider>
  );
  const element = screen.getByTitle('actual owned frame');
  expect(element.getAttribute('src')).toBe('about:blank');
  expect(observe).not.toHaveBeenCalled();
  await act(async () => pending.resolve(replay()));
  await waitFor(() => expect(element.getAttribute('src')).toBe('/served/frame.html'));
  expect(observe).toHaveBeenCalledTimes(1);
  expect(observe.mock.calls[0][0]).toMatchObject({
    documentId: 'frame-doc',
    transportOwner: transport,
    eligibility: 'served-document',
    exactOrigin: 'null',
  });
  // The real browser onLoad/handshake is separate acceptance; no synthetic loaded witness.
  expect(loaded).not.toHaveBeenCalled();
});
it('cannot assign source or capture a retired node after its held original replay resolves', async () => {
  const transport = createMockTransport(),
    pending = deferred<CanvasChannelReplayResponse>();
  vi.mocked(transport.getCanvasChannel).mockReturnValue(pending.promise);
  const observe = vi.spyOn(FrameLifetimeController.prototype, 'observeHostContext');
  const hook = render(
    <TransportProvider transport={transport}>
      <Host />
    </TransportProvider>
  );
  const element = screen.getByTitle('actual owned frame');
  hook.unmount();
  await act(async () => pending.resolve(replay()));
  expect(observe).not.toHaveBeenCalled();
  expect(element.getAttribute('src')).toBe('about:blank');
});

it('a same-URL physical replacement receives the held replay without assigning the retired element', async () => {
  const transport = createMockTransport(),
    pending = deferred<CanvasChannelReplayResponse>();
  vi.mocked(transport.getCanvasChannel).mockReturnValue(pending.promise);
  const observe = vi.spyOn(FrameLifetimeController.prototype, 'observeHostContext');
  const hook = render(
    <TransportProvider transport={transport}>
      <Host />
    </TransportProvider>
  );
  const old = screen.getByTitle('actual owned frame') as HTMLIFrameElement;
  const oldWindow = old.contentWindow;
  expect(oldWindow !== null).toBe(true);
  hook.rerender(
    <TransportProvider transport={transport}>
      <Host nonce={1} />
    </TransportProvider>
  );
  const fresh = screen.getByTitle('actual owned frame') as HTMLIFrameElement;
  const freshWindow = fresh.contentWindow;
  expect(freshWindow !== null).toBe(true);
  expect(fresh).not.toBe(old);
  expect(old.getAttribute('src')).toBe('about:blank');
  await act(async () => pending.resolve(replay()));
  await waitFor(() => expect(fresh.getAttribute('src')).toBe('/served/frame.html'));
  expect(observe).toHaveBeenCalledTimes(1);
  // Host capture precedes src assignment; jsdom may dispose that Window on navigation.
  const capturedFrame = observe.mock.calls[0][0].frame;
  expect(capturedFrame === freshWindow).toBe(true);
  expect(capturedFrame === oldWindow).toBe(false);
  expect(old.getAttribute('src')).toBe('about:blank');
});
it('a late old Transport replay cannot prepare the replacement physical frame', async () => {
  const old = createMockTransport(),
    fresh = createMockTransport();
  const oldPage = deferred<CanvasChannelReplayResponse>(),
    freshPage = deferred<CanvasChannelReplayResponse>();
  vi.mocked(old.getCanvasChannel).mockReturnValue(oldPage.promise);
  vi.mocked(fresh.getCanvasChannel).mockReturnValue(freshPage.promise);
  const observe = vi.spyOn(FrameLifetimeController.prototype, 'observeHostContext');
  const hook = render(
    <TransportProvider transport={old}>
      <Host />
    </TransportProvider>
  );
  const retired = screen.getByTitle('actual owned frame') as HTMLIFrameElement;
  const retiredWindow = retired.contentWindow;
  expect(retiredWindow !== null).toBe(true);
  hook.rerender(
    <TransportProvider transport={fresh}>
      <Host />
    </TransportProvider>
  );
  const current = screen.getByTitle('actual owned frame') as HTMLIFrameElement;
  const currentWindow = current.contentWindow;
  expect(currentWindow !== null).toBe(true);
  expect(current).not.toBe(retired);
  await act(async () => oldPage.resolve(replay()));
  expect(observe).not.toHaveBeenCalled();
  expect(current.getAttribute('src')).toBe('about:blank');
  await act(async () => freshPage.resolve(replay()));
  await waitFor(() => expect(current.getAttribute('src')).toBe('/served/frame.html'));
  expect(observe).toHaveBeenCalledTimes(1);
  const captured = observe.mock.calls[0][0];
  expect(captured.frame === currentWindow).toBe(true);
  expect(captured.frame === retiredWindow).toBe(false);
  expect(captured.transportOwner === fresh).toBe(true);
  expect(retired.getAttribute('src')).toBe('about:blank');
});
it('non-opted-in resolved pages remain displayable without host capture or a Doc lease', async () => {
  const transport = createMockTransport();
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay());
  const observe = vi.spyOn(FrameLifetimeController.prototype, 'observeHostContext');
  const acquire = vi.spyOn(FrameLifetimeController.prototype, 'acquireDoc');
  render(
    <TransportProvider transport={transport}>
      <Host bridgeEligibility={null} />
    </TransportProvider>
  );
  await waitFor(() =>
    expect(screen.getByTitle('actual owned frame').getAttribute('src')).toBe('/served/frame.html')
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(observe).not.toHaveBeenCalled();
  expect(acquire).not.toHaveBeenCalled();
});

it('an initial sibling notification owns no Doc capture and cannot cancel first preparation', async () => {
  const transport = createMockTransport();
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay());
  const observe = vi.spyOn(FrameLifetimeController.prototype, 'observeHostContext');
  const loaded = vi.spyOn(FrameLifetimeController.prototype, 'observeLoaded');
  render(
    <TransportProvider transport={transport}>
      <Host retireWhileBlank />
    </TransportProvider>
  );
  const element = screen.getByTitle('actual owned frame');
  await waitFor(() => expect(element.getAttribute('src')).toBe('/served/frame.html'));
  expect(observe).toHaveBeenCalledTimes(1);
  expect(loaded).not.toHaveBeenCalled();
  expect(element.getAttribute('data-requires-reload')).toBe('no');
});
it('a late old Window retirement cannot retire the replacement physical capture', async () => {
  const transport = createMockTransport(),
    pending = deferred<CanvasChannelReplayResponse>();
  vi.mocked(transport.getCanvasChannel).mockReturnValue(pending.promise);
  let retire: ((frame?: Window) => void) | undefined;
  const expose = (value: (frame?: Window) => void) => {
    retire = value;
  };
  const host = render(
    <TransportProvider transport={transport}>
      <Host exposeRetirement={expose} />
    </TransportProvider>
  );
  const old = screen.getByTitle('actual owned frame') as HTMLIFrameElement,
    oldWindow = old.contentWindow;
  expect(oldWindow !== null).toBe(true);
  host.rerender(
    <TransportProvider transport={transport}>
      <Host nonce={1} exposeRetirement={expose} />
    </TransportProvider>
  );
  const fresh = screen.getByTitle('actual owned frame');
  await act(async () => pending.resolve(replay()));
  await waitFor(() => expect(fresh.getAttribute('src')).toBe('/served/frame.html'));
  expect(retire).toBeDefined();
  act(() => retire!(oldWindow!));
  expect(fresh.getAttribute('data-requires-reload')).toBe('no');
  expect(fresh.getAttribute('src')).toBe('/served/frame.html');
  expect(old.getAttribute('src')).toBe('about:blank');
});
