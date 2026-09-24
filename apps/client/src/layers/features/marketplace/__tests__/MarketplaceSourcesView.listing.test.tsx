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
import type {
  AddedMarketplaceSource,
  MarketplaceSource,
  RefreshedMarketplaceSource,
} from '@dorkos/shared/marketplace-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { MarketplaceSourcesView } from '../ui/MarketplaceSourcesView';

const toastSuccess = vi.hoisted(() => vi.fn());
const toastWarning = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { success: toastSuccess, warning: toastWarning } }));

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

/** The source's row, found by its name. */
async function findRow(name: string): Promise<HTMLElement> {
  const row = (await screen.findByText(name)).closest('[data-slot="source-card"]');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

/** The one polite live region the page announces listing news through. */
function liveRegion(): HTMLElement {
  const region = document.querySelector('[data-slot="listing-announcer"]');
  expect(region).not.toBeNull();
  expect(region).toHaveAttribute('aria-live', 'polite');
  return region as HTMLElement;
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

    const row = await findRow('my-team');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalledWith('Added my-team. 12 packages are ready to install.');
    expect(within(row).getByLabelText('Enabled')).toBeInTheDocument();
    expect(screen.queryByText(/didn't load/)).not.toBeInTheDocument();
  });

  it('says the source was saved and why its packages did not load, with a Try again beside it', async () => {
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

    const note =
      "Added, but its packages didn't load: there's no marketplace listing at that address.";
    const row = await findRow('my-team');
    expect(await within(row).findByText(note)).toBeInTheDocument();
    // The retry sits in the note itself: on a phone the row's Refresh is an icon.
    expect(within(row).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    // The dot no longer says all is well.
    expect(within(row).getByLabelText("Enabled, but its packages didn't load")).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastWarning).toHaveBeenCalledWith("Added my-team, but its packages didn't load.");
    expect(liveRegion()).toHaveTextContent(`my-team: ${note}`);
  });

  it('clears the note once Try again loads the listing', async () => {
    // Purpose: the retry the note offers has to work, and put the row back.
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
        stale: false,
      }),
    });

    await addSource(user);
    const row = await findRow('my-team');
    await user.click(await within(row).findByRole('button', { name: 'Try again' }));

    expect(transport.refreshMarketplaceSource).toHaveBeenCalledWith('my-team');
    expect(toastSuccess).toHaveBeenCalledWith(
      'Refreshed my-team. 3 packages are ready to install.'
    );
    expect(within(row).queryByText(/didn't load/)).not.toBeInTheDocument();
    expect(within(row).getByLabelText('Enabled')).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent('my-team: 3 packages are ready to install.');
  });

  it('shows why a Refresh failed on the row, and keeps focus on the button while it runs', async () => {
    // Purpose: a Refresh on any row reports its outcome, and a busy button
    // that went `disabled` would drop keyboard focus mid-action.
    const user = userEvent.setup();
    let fail!: (err: Error) => void;
    renderView({
      listMarketplaceSources: vi.fn().mockResolvedValue([SAVED]),
      refreshMarketplaceSource: vi.fn(
        () =>
          new Promise<RefreshedMarketplaceSource>((_resolve, reject) => {
            fail = reject;
          })
      ),
    });

    const row = await findRow('my-team');
    const refresh = within(row).getByRole('button', { name: 'Refresh my-team' });
    await user.click(refresh);

    expect(refresh).toHaveAttribute('aria-busy', 'true');
    expect(refresh).not.toBeDisabled();
    fail(new Error('the server at that address refused the connection'));

    const note = "Its packages didn't load: the server at that address refused the connection.";
    expect(await within(row).findByText(note)).toBeInTheDocument();
    expect(refresh).toHaveAttribute('aria-busy', 'false');
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastWarning).toHaveBeenCalledWith("Couldn't refresh my-team.");
    expect(liveRegion()).toHaveTextContent(`my-team: ${note}`);
  });

  it('says so when Refresh could only show the last copy, and when that copy is from', async () => {
    // Purpose: with the server down, refresh answers with the cached copy;
    // calling that "Refreshed" would claim a check that did not happen.
    const user = userEvent.setup();
    renderView({
      listMarketplaceSources: vi.fn().mockResolvedValue([SAVED]),
      refreshMarketplaceSource: vi.fn().mockResolvedValue({
        marketplace: { plugins: [{}, {}] },
        fetchedAt: '2026-09-20T08:00:00.000Z',
        stale: true,
        reason: 'the server at that address refused the connection',
      }),
    });

    const row = await findRow('my-team');
    await user.click(within(row).getByRole('button', { name: 'Refresh my-team' }));

    const when = new Date('2026-09-20T08:00:00.000Z').toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    expect(
      await within(row).findByText(
        `Couldn't reach it: the server at that address refused the connection. Still showing the last copy, from ${when}.`
      )
    ).toBeInTheDocument();
    expect(
      within(row).getByLabelText('Enabled, but showing an older copy of its packages')
    ).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastWarning).toHaveBeenCalledWith(
      "Couldn't reach my-team. Still showing the last copy."
    );
  });
});
