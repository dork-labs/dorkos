// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LocalBrowserCapabilities, LocalBrowserState } from '@dorkos/shared/local-browser';
import type { Transport } from '@dorkos/shared/transport';
import { LocalBrowserPanel } from '../ui/LocalBrowserPanel';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/layers/shared/ui';

// DOR-4438 security Musts: the still of a covered page lives in the panel's memory
// only. It never reaches a store, browser storage, or anything sent to the server.

const transport = {
  getLocalBrowserState: vi.fn(),
  getLocalBrowserCapabilities: vi.fn(),
  openLocalBrowser: vi.fn(),
  pauseLocalBrowser: vi.fn(),
  resumeLocalBrowser: vi.fn(),
  disconnectLocalBrowser: vi.fn(),
  selectLocalBrowserTab: vi.fn(),
  navigateLocalBrowser: vi.fn(),
  interruptSession: vi.fn(),
  getSession: vi.fn(),
  getAgentByPath: vi.fn(),
};

const embedded: LocalBrowserState = {
  connectionId: 'owned',
  sessionId: 'chat-one',
  mode: 'embedded',
  status: 'connected',
  paused: false,
  tabs: [{ id: 'one', title: 'Invoices', url: 'https://example.com' }],
  selectedTabId: 'one',
  revision: 0,
  preparation: null,
};
const capabilities: LocalBrowserCapabilities = {
  embedded: true,
  newWindow: true,
  defaultMode: 'embedded',
  platform: 'darwin',
  managedChromiumVersion: '157.0.8103.15',
  unavailableReasons: {},
  playwrightVersion: '1.65.0-alpha-2026-10-30',
};
const WINDOW = { x: 0, y: 0, width: 1200, height: 800 };
const PAGE = { x: 700, y: 200, width: 480, height: 500 };
// A JPEG's first bytes, so a leak is recognisable wherever it lands.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x44, 0x4f, 0x52, 0x4b]);

function Window({ settings }: { settings: boolean }) {
  return (
    <>
      <LocalBrowserPanel sessionId="chat-one" agentName="Kai" />
      <Dialog open={settings}>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Your preferences</DialogDescription>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Every value reachable from `value`, so a still hidden anywhere inside is found. */
function leaks(value: unknown, seen = new Set<unknown>()): string[] {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' && /^(blob:|data:image\/)|image\/jpeg/.test(value)
      ? [value]
      : [];
  }
  if (seen.has(value)) return [];
  seen.add(value);
  if (value instanceof Blob || ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
    return [String(value)];
  return Object.values(value).flatMap((child) => leaks(child, seen));
}

let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  useAppStore.setState({ localBrowserChoice: null, localBrowserChoiceIssue: null });
  transport.getLocalBrowserState.mockResolvedValue(embedded);
  transport.getLocalBrowserCapabilities.mockResolvedValue(capabilities);
  transport.getAgentByPath.mockResolvedValue(null);
  window.electronAPI = {
    localBrowser: {
      setBounds: vi.fn().mockResolvedValue(undefined),
      captureStill: vi.fn().mockResolvedValue(JPEG),
    },
  } as unknown as ElectronAPI;
  URL.createObjectURL = vi.fn(() => 'blob:still-page');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const box = this.matches('[data-slot$="-overlay"]') ? WINDOW : PAGE;
    return { ...box, top: box.y, left: box.x, toJSON: () => box } as DOMRect;
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  delete window.electronAPI;
  vi.restoreAllMocks();
});

describe('LocalBrowserPanel still (DOR-4438)', () => {
  it('keeps the still in the panel: never in a store, storage, or the transport', async () => {
    const at = (settings: boolean) => (
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport as unknown as Transport}>
          <Window settings={settings} />
        </TransportProvider>
      </QueryClientProvider>
    );
    const view = render(at(false));
    const bridge = window.electronAPI!.localBrowser!;
    await waitFor(() =>
      expect(bridge.setBounds).toHaveBeenCalledWith(expect.objectContaining({ visible: true }))
    );

    view.rerender(at(true));
    await screen.findByRole('dialog');
    const still = await waitFor(() => {
      const image = document.querySelector('[data-slot="native-browser-still"]');
      expect(image).not.toBeNull();
      return image as HTMLImageElement;
    });
    expect(still.getAttribute('src')).toBe('blob:still-page');
    await waitFor(() =>
      expect(bridge.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
    );

    // While Settings is open over the page, nothing outside the panel holds the still.
    for (const call of Object.values(transport)) expect(leaks(call.mock.calls)).toEqual([]);
    expect(leaks(useAppStore.getState())).toEqual([]);
    expect(
      leaks(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data)
      )
    ).toEqual([]);
    expect(leaks({ ...localStorage })).toEqual([]);
    expect(leaks({ ...sessionStorage })).toEqual([]);

    // Closing the page drops it.
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:still-page');
  });
});
