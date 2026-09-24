/**
 * @vitest-environment jsdom
 */
/**
 * What the sources page says about a new source's listing (DOR-2304).
 *
 * Adding a source fetches its listing once on the server. These tests drive the
 * real hooks against a mock Transport, so what is asserted is what a person
 * sees: the package count when the fetch worked, a note that the source was
 * saved and why its packages didn't load when it failed, and a Refresh on the
 * row that tries again.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { AddedMarketplaceSource, MarketplaceSource } from '@dorkos/shared/marketplace-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { MarketplaceSourcesView } from '../ui/MarketplaceSourcesView';

const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { success: toastSuccess } }));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = vi.fn();
  if (!proto.releasePointerCapture) proto.releasePointerCapture = vi.fn();
  if (!proto.scrollIntoView) proto.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const SAVED: MarketplaceSource = {
  name: 'my-team',
  source: 'https://github.com/my-team/marketplace',
  enabled: true,
  addedAt: '2026-09-24T10:00:00.000Z',
};

function renderView(overrides: Partial<Transport>) {
  const transport = createMockTransport({
    // Empty before the add; the saved source once the add invalidates the list.
    listMarketplaceSources: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([SAVED]),
    ...overrides,
  } as Partial<Transport>);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(<MarketplaceSourcesView />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  });
  return transport;
}

async function addSource(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add marketplace source' }));
  await user.type(screen.getByLabelText('Repository link'), SAVED.source);
  await user.type(screen.getByLabelText('Name'), SAVED.name);
  await user.click(screen.getByRole('button', { name: 'Add source' }));
}

function added(listing: AddedMarketplaceSource['listing']): AddedMarketplaceSource {
  return { ...SAVED, listing };
}

describe('MarketplaceSourcesView — the new source listing (DOR-2304)', () => {
  it('says how many packages are ready when the listing loaded', async () => {
    // Purpose: the same outcome the CLI prints, so a person knows they can
    // install straight away.
    const user = userEvent.setup();
    renderView({
      addMarketplaceSource: vi.fn().mockResolvedValue(added({ fetched: true, packageCount: 12 })),
    });

    await addSource(user);

    expect(await screen.findByText('my-team')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalledWith('Added my-team. 12 packages are ready to install.');
    expect(screen.queryByText(/didn't load/)).not.toBeInTheDocument();
  });

  it('says the source was saved, why its packages did not load, and offers Refresh', async () => {
    // Purpose: a failed first fetch used to close the dialog as if all was
    // well; the person then met "no cached document" at install time.
    const user = userEvent.setup();
    renderView({
      addMarketplaceSource: vi
        .fn()
        .mockResolvedValue(
          added({ fetched: false, reason: "there's no marketplace listing at that address" })
        ),
    });

    await addSource(user);

    const note = await screen.findByText(
      "Added, but its packages didn't load: there's no marketplace listing at that address. Try Refresh."
    );
    expect(note).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Refresh my-team' })).toBeInTheDocument();
  });

  it('clears the note once Refresh loads the listing', async () => {
    // Purpose: Refresh is the retry the note points at, and it has to work.
    const user = userEvent.setup();
    const transport = renderView({
      addMarketplaceSource: vi
        .fn()
        .mockResolvedValue(
          added({ fetched: false, reason: "couldn't find a server at that address" })
        ),
      refreshMarketplaceSource: vi.fn().mockResolvedValue({
        marketplace: { plugins: [{}, {}, {}] },
        fetchedAt: '2026-09-24T10:01:00.000Z',
      }),
    });

    await addSource(user);
    await screen.findByText(/its packages didn't load/);
    await user.click(screen.getByRole('button', { name: 'Refresh my-team' }));

    expect(transport.refreshMarketplaceSource).toHaveBeenCalledWith('my-team');
    expect(toastSuccess).toHaveBeenCalledWith(
      'Refreshed my-team. 3 packages are ready to install.'
    );
    expect(screen.queryByText(/its packages didn't load/)).not.toBeInTheDocument();
  });

  it('shows why a Refresh failed on the row', async () => {
    // Purpose: a Refresh on any row, not just a new one, reports its outcome.
    const user = userEvent.setup();
    renderView({
      listMarketplaceSources: vi.fn().mockResolvedValue([SAVED]),
      refreshMarketplaceSource: vi
        .fn()
        .mockRejectedValue(new Error('the server at that address refused the connection')),
    });

    const row = (await screen.findByText('my-team')).closest('[data-slot="source-card"]');
    expect(row).not.toBeNull();
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Refresh my-team' }));

    expect(
      await screen.findByText(
        "Its packages didn't load: the server at that address refused the connection. Try Refresh."
      )
    ).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
