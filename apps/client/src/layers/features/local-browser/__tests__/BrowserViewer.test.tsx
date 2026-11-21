// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { BrowserViewer } from '../ui/BrowserViewer';

const subscription = {
  metadata: {
    revision: 0,
    navigationGeneration: 0,
    controlEpoch: 0,
    viewport: null,
    control: null,
    chooser: null,
  },
  viewerId: 'v'.repeat(43),
  nonce: 'n'.repeat(43),
  binding: { chatId: 'chat', profileId: 'profile', connectionId: 'connection', tabId: 'tab' },
};
const drawImage = vi.fn();
const clearRect = vi.fn();
const closeBitmap = vi.fn();
const bitmap = { width: 640, height: 480, close: closeBitmap };
const props = { chatId: 'chat', connectionId: 'connection', tabId: 'tab', visible: true };

function frame() {
  return {
    view: subscription.metadata,
    sequence: 1,
    generation: 1,
    width: 640,
    height: 480,
    byteLength: 3,
    receipt: 'r'.repeat(43),
    bytes: new Uint8Array([1, 2, 3]),
  };
}

function fixture() {
  const transport = createMockTransport({
    subscribeBrowserViewer: vi.fn().mockResolvedValue(subscription),
    nextBrowserViewerFrame: vi.fn().mockImplementation(() => new Promise(() => undefined)),
    closeBrowserViewer: vi.fn().mockResolvedValue(undefined),
  });
  const tree = (changes = {}) => (
    <TransportProvider transport={transport}>
      <BrowserViewer {...props} {...changes} />
    </TransportProvider>
  );
  return { transport, tree };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
    clearRect,
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('watch-only browser viewer', () => {
  it('keeps a planted pixel marker out of browser storage', async () => {
    const f = fixture();
    const marker = 'MADE_UP_VIEWER_STORAGE_MARKER_b41c';
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const bytes = Uint8Array.from(marker, (character) => character.charCodeAt(0));
    vi.mocked(f.transport.nextBrowserViewerFrame).mockResolvedValueOnce({
      ...frame(),
      bytes,
      byteLength: bytes.length,
    });
    const view = render(f.tree());
    await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(writes.mock.calls)).not.toContain(marker);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(marker);
    expect(bytes.every((value) => value === 0)).toBe(true);
    view.unmount();
  });

  it('draws and releases each bitmap before acknowledging it with the next poll', async () => {
    const f = fixture();
    const pixels = frame();
    vi.mocked(f.transport.nextBrowserViewerFrame).mockResolvedValueOnce(pixels);
    const view = render(f.tree());
    await waitFor(() => expect(f.transport.nextBrowserViewerFrame).toHaveBeenCalledTimes(2));
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(closeBitmap).toHaveBeenCalledTimes(1);
    expect(pixels.bytes).toEqual(new Uint8Array(3));
    expect(vi.mocked(f.transport.nextBrowserViewerFrame).mock.calls[1]![1]).toBe(pixels.receipt);
    expect(screen.getByText('To click or type, use the Chrome window.')).toBeInTheDocument();
    view.unmount();
    await waitFor(() => expect(f.transport.closeBrowserViewer).toHaveBeenCalledWith(subscription));
  });

  it('clears pixels and unsubscribes as soon as the panel is hidden', async () => {
    const f = fixture();
    vi.mocked(f.transport.nextBrowserViewerFrame).mockResolvedValueOnce(frame());
    const view = render(f.tree());
    await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(1));
    const previousClears = clearRect.mock.calls.length;
    view.rerender(f.tree({ visible: false }));
    expect(clearRect.mock.calls.length).toBeGreaterThan(previousClears);
    await waitFor(() => expect(f.transport.closeBrowserViewer).toHaveBeenCalledTimes(1));
  });

  it('closes a subscription that resolves after unmount', async () => {
    const f = fixture();
    let finish!: (value: typeof subscription) => void;
    vi.mocked(f.transport.subscribeBrowserViewer).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const view = render(f.tree());
    view.unmount();
    await act(async () => {
      finish(subscription);
    });
    expect(f.transport.closeBrowserViewer).toHaveBeenCalledWith(subscription);
    expect(f.transport.nextBrowserViewerFrame).not.toHaveBeenCalled();
  });

  it('drops a late decoded frame after the person changes chats', async () => {
    const f = fixture();
    let finish!: (value: ImageBitmap) => void;
    vi.mocked(f.transport.nextBrowserViewerFrame).mockResolvedValueOnce(frame());
    vi.mocked(createImageBitmap).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const view = render(f.tree());
    await waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(1));
    view.rerender(f.tree({ chatId: 'other-chat', visible: false }));
    await act(async () => {
      finish(bitmap as ImageBitmap);
    });
    expect(drawImage).not.toHaveBeenCalled();
    expect(closeBitmap).toHaveBeenCalledTimes(1);
  });

  it('does not draw a subscription resolved for a different selected tab', async () => {
    const f = fixture();
    vi.mocked(f.transport.subscribeBrowserViewer).mockResolvedValueOnce({
      ...subscription,
      binding: { ...subscription.binding, tabId: 'other-tab' },
    });
    render(f.tree());
    await screen.findByText('The live view stopped.');
    expect(f.transport.nextBrowserViewerFrame).not.toHaveBeenCalled();
    expect(drawImage).not.toHaveBeenCalled();
  });

  it.each([
    ['viewer_person_only', 'Sign in to DorkOS as its owner to watch.'],
    ['viewer_denied', 'Sign in to DorkOS as its owner to watch.'],
    ['viewer_local_only', 'Open DorkOS on your computer to watch.'],
    ['viewer_unavailable', 'The live view stopped.'],
  ])('explains %s without hiding the recovery action', async (code, message) => {
    const f = fixture();
    vi.mocked(f.transport.subscribeBrowserViewer).mockRejectedValueOnce(
      Object.assign(new Error(code), { code })
    );
    const view = render(f.tree());
    expect(await screen.findByText(message)).toBeInTheDocument();
    if (code === 'viewer_unavailable')
      expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    else expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
    view.unmount();
  });
});
