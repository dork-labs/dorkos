// @vitest-environment jsdom
import { act, fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react';
import { expect, it, vi, onTestFinished } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import type { ManagedBrowserCanvasReference } from '@dorkos/shared/types';
import type { BrowserCanvasTransport, BrowserViewerTransport } from '@dorkos/shared/transport';
import type { ManagedBrowserViewerProps } from '../ui/ManagedBrowserViewer';
import { ManagedBrowserCanvasContent } from '../ui/ManagedBrowserCanvasContent';
// HTTP-port/component doubles only: these do not qualify native rendering or auth.
const renders = vi.hoisted(() => [] as ManagedBrowserViewerProps[]);
vi.mock('../ui/ManagedBrowserViewer', () => ({
  ManagedBrowserViewer: (props: ManagedBrowserViewerProps) => {
    renders.push(props);
    return <div data-testid="original-viewer" />;
  },
}));
const reference: ManagedBrowserCanvasReference = {
  type: 'managed_browser',
  attachmentId: 'attachment_original_reference_0001',
  browserId: 'browser_original_reference_000001',
  browserGeneration: 1,
  tabId: 'tab_original_reference_000000001',
  ownerAuthorId: 'owner_actual_author',
  scope: { kind: 'room', roomId: 'room_original_reference_00000001' },
};
const binding = {
  browserId: reference.browserId,
  browserGeneration: 1,
  tabId: reference.tabId,
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 0,
  inputGeneration: 0,
};
function fixture() {
  renders.length = 0;
  const delivery: BrowserViewerTransport = {
    issueBrowserViewer: vi.fn(),
    nextBrowserViewerFrame: vi.fn(),
    disconnectBrowserViewer: vi.fn(),
  };
  const port: BrowserCanvasTransport = {
    createCanvasViewerDelivery: vi.fn(() => delivery),
    presentBrowserCanvas: vi.fn(),
    shareBrowserCanvas: vi.fn(),
    detachBrowserCanvas: vi.fn(),
    resolveBrowserCanvas: vi.fn(async () => ({
      owner: false,
      binding,
      grant: { grantId: 'grant_original_reference_00000001', revision: 0 },
    })),
  };
  const transport = createMockTransport({ browserCanvas: port });
  const originals: Promise<unknown>[] = [],
    releases: (() => void)[] = [];
  onTestFinished(async () => {
    cleanup();
    for (const release of releases) release();
    for (const result of await Promise.allSettled(originals))
      if (result.status === 'rejected') throw result.reason;
  });
  const mount = (content = reference) =>
    render(
      <TransportProvider transport={transport}>
        <ManagedBrowserCanvasContent content={content} />
      </TransportProvider>
    );
  return { port, delivery, transport, mount, originals, releases };
}
it('replayed metadata starts no viewing until an explicit authenticated resolution', async () => {
  const f = fixture();
  f.mount();
  expect(f.port.resolveBrowserCanvas).not.toHaveBeenCalled();
  expect(renders).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'View browser' }));
  await waitFor(() => expect(renders).toHaveLength(1));
  expect(f.port.resolveBrowserCanvas).toHaveBeenCalledWith(
    { attachmentId: reference.attachmentId },
    expect.any(AbortSignal)
  );
  expect(renders[0]!.delivery).toBe(f.delivery);
  expect(renders[0]!.context?.binding).toEqual(binding);
  expect(renders[0]!.input).toBeUndefined();
});
it('a different canonical tab from the original HTTP receipt never publishes a viewer', async () => {
  const f = fixture();
  vi.mocked(f.port.resolveBrowserCanvas).mockResolvedValueOnce({
    owner: false,
    binding: { ...binding, tabId: 'tab_other_reference_00000000001' },
  });
  f.mount();
  fireEvent.click(screen.getByRole('button', { name: 'View browser' }));
  await screen.findByRole('status');
  expect(f.port.createCanvasViewerDelivery).not.toHaveBeenCalled();
  expect(renders).toHaveLength(0);
});
it('unmount aborts a held original resolution and cannot publish its late viewer', async () => {
  const f = fixture(),
    bank: { release?: () => void; signal?: AbortSignal } = {};
  const held = new Promise<void>((resolve) => {
    bank.release = resolve;
  });
  const release = () => {
    const original = bank.release;
    bank.release = undefined;
    original?.();
  };
  f.releases.push(release);
  vi.mocked(f.port.resolveBrowserCanvas).mockImplementationOnce((_value, signal) => {
    bank.signal = signal;
    const original = held.then(() => ({ owner: false, binding }));
    f.originals.push(original);
    return original;
  });
  const view = f.mount();
  fireEvent.click(screen.getByRole('button', { name: 'View browser' }));
  await waitFor(() => expect(bank.signal).toBeDefined());
  view.unmount();
  expect(bank.signal!.aborted).toBe(true);
  await act(async () => {
    release();
    await Promise.all(f.originals);
  });
  expect(f.port.createCanvasViewerDelivery).not.toHaveBeenCalled();
  expect(renders).toHaveLength(0);
});
it('replacement of the reference fences the original display before a new explicit view', async () => {
  const f = fixture(),
    view = f.mount();
  fireEvent.click(screen.getByRole('button', { name: 'View browser' }));
  await waitFor(() => expect(renders).toHaveLength(1));
  const original = renders[0]!;
  view.rerender(
    <TransportProvider transport={f.transport}>
      <ManagedBrowserCanvasContent
        content={{
          ...reference,
          attachmentId: 'attachment_replaced_reference_001',
        }}
      />
    </TransportProvider>
  );
  expect(original.lossSignal.aborted).toBe(true);
  expect(screen.queryByTestId('original-viewer')).toBeNull();
  expect(f.port.resolveBrowserCanvas).toHaveBeenCalledTimes(1);
});
