// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ManagedBrowserSessions } from '../ui/ManagedBrowserSessions';
import type { Transport } from '@dorkos/shared/transport';
import type { BrowserCloseRequest, BrowserInstance } from '@dorkos/shared/browser-schemas';

const original: BrowserInstance = {
  browserId: 'browser_original_000000000001',
  browserGeneration: 3,
  mode: 'ephemeral',
  status: 'running',
};
function setup(transport: Transport) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={cache}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  };
}

describe('owner browser selection', () => {
  it('selects the actual original generation without creating a controller', async () => {
    const onSelect = vi.fn();
    const wrapper = setup(
      createMockTransport({
        getBrowserInstances: vi.fn().mockResolvedValue([original]),
        getBrowserProfiles: vi.fn().mockResolvedValue([]),
      })
    );
    render(<ManagedBrowserSessions owner="alice" onSelect={onSelect} />, { wrapper });
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    expect(onSelect).toHaveBeenCalledWith(original);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('marks only the selected original generation among identical saved-profile labels', async () => {
    const selected: BrowserInstance = {
      ...original,
      mode: 'persistent',
      profileId: 'profile_original_000000000001',
    };
    const instances: BrowserInstance[] = [
      { ...selected, browserGeneration: 2, status: 'uncertain' },
      { ...selected, browserId: 'browser_history_000000000001', status: 'uncertain' },
      selected,
    ];
    const closeBrowserInstance = vi.fn(async (request: BrowserCloseRequest) => ({
      ...request,
      cleanup: 'observed' as const,
    }));
    const wrapper = setup(
      createMockTransport({
        getBrowserInstances: vi.fn().mockResolvedValue(instances),
        getBrowserProfiles: vi
          .fn()
          .mockResolvedValue([
            { profileId: selected.profileId, label: 'Saved work', revision: 1, status: 'inUse' },
          ]),
        closeBrowserInstance,
      })
    );
    const view = render(
      <ManagedBrowserSessions owner="alice" selected={selected} onSelect={vi.fn()} />,
      { wrapper }
    );
    await screen.findAllByText('Saved work');
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual([null, null, 'true']);
    expect(
      rows.every(
        (row) => !within(row).getByRole('button', { name: 'Close' }).hasAttribute('disabled')
      )
    ).toBe(true);
    const currentRow = rows.find((row) => row.getAttribute('aria-current') === 'true');
    if (!currentRow) throw new Error('Original selected browser row required');
    fireEvent.click(within(currentRow).getByRole('button', { name: 'Close' }));
    await screen.findByText('Browser closed.');
    expect(closeBrowserInstance).toHaveBeenCalledExactlyOnceWith({
      requestId: expect.any(String),
      browserId: selected.browserId,
      browserGeneration: selected.browserGeneration,
    });
    view.rerender(<ManagedBrowserSessions owner="alice" onSelect={vi.fn()} />);
    expect(screen.getAllByRole('listitem').every((row) => !row.hasAttribute('aria-current'))).toBe(
      true
    );
  });

  it('preserves unverified cleanup and closes exactly the selected generation once', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closeBrowserInstance = vi.fn(async (request: BrowserCloseRequest) => {
      await held;
      return {
        ...request,
        cleanup: 'unverified' as const,
        reason: 'observationUnavailable' as const,
      };
    });
    const wrapper = setup(
      createMockTransport({
        getBrowserInstances: vi.fn().mockResolvedValue([original]),
        getBrowserProfiles: vi.fn().mockResolvedValue([]),
        closeBrowserInstance,
      })
    );
    render(<ManagedBrowserSessions owner="alice" onSelect={vi.fn()} />, { wrapper });
    try {
      const close = await screen.findByRole('button', { name: 'Close' });
      fireEvent.click(close);
      fireEvent.click(close);
      await waitFor(() => expect(closeBrowserInstance).toHaveBeenCalledOnce());
      expect(closeBrowserInstance.mock.calls[0]?.[0]).toEqual({
        requestId: expect.any(String),
        browserId: original.browserId,
        browserGeneration: 3,
      });
      release?.();
      expect(await screen.findByText(/cleanup could not be confirmed/)).toBeTruthy();
      expect(screen.queryByText('Browser closed.')).toBeNull();
    } finally {
      release?.();
      await held;
    }
  });

  it('does not carry a late original close receipt into the next signed-in identity', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closeBrowserInstance = vi.fn(async (request: BrowserCloseRequest) => {
      await held;
      return { ...request, cleanup: 'observed' as const };
    });
    let owner = 'alice';
    const wrapper = setup(
      createMockTransport({
        getBrowserInstances: vi.fn(async () => (owner === 'alice' ? [original] : [])),
        getBrowserProfiles: vi.fn().mockResolvedValue([]),
        closeBrowserInstance,
      })
    );
    const view = render(<ManagedBrowserSessions owner={owner} onSelect={vi.fn()} />, { wrapper });
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
      await waitFor(() => expect(closeBrowserInstance).toHaveBeenCalledOnce());
      owner = 'bob';
      view.rerender(<ManagedBrowserSessions owner={owner} onSelect={vi.fn()} />);
      await screen.findByText('No browsers are open.');
      release?.();
      await held;
      await waitFor(() => expect(screen.queryByText('Browser closed.')).toBeNull());
      expect(screen.queryByRole('button', { name: 'View' })).toBeNull();
    } finally {
      release?.();
      await held;
    }
  });
});
