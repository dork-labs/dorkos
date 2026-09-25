/**
 * @vitest-environment jsdom
 */
/**
 * What the sources page says about each source's listing (DOR-2304, DOR-2324).
 *
 * The row's dot and note come from the server's record of the last fetch
 * (`lastFetch` on `GET /sources`), so they survive a reload and every window
 * agrees. Adds and refreshes toast and announce the moment they finish. These
 * tests drive the real hooks against a mock Transport whose list answers from
 * a mutable "server" record.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type {
  AddedMarketplaceSource,
  ListedMarketplaceSource,
  RefreshedMarketplaceSource,
  SourceLastFetch,
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

const BASE = {
  name: 'my-team',
  source: 'https://github.com/my-team/marketplace',
  enabled: true,
  addedAt: '2026-09-24T10:00:00.000Z',
};

/** What the fake server lists: nothing until an add, then the source with its record. */
let server: ListedMarketplaceSource[];

function record(lastFetch: SourceLastFetch, source = BASE.source): void {
  server = [{ ...BASE, source, lastFetch }];
}

const FAILED: SourceLastFetch = {
  state: 'failed',
  checkedAt: '2026-09-24T10:00:00.000Z',
  reason: "there's no marketplace listing at that address",
};

function renderView(overrides: Partial<Transport>) {
  const transport = createMockTransport({
    listMarketplaceSources: vi.fn(async () => server),
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
  await user.type(screen.getByLabelText('Repository link'), BASE.source);
  await user.type(screen.getByLabelText('Name'), BASE.name);
  await user.click(screen.getByRole('button', { name: 'Add source' }));
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

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

describe('MarketplaceSourcesView — each source listing (DOR-2304, DOR-2324)', () => {
  beforeEach(() => {
    server = [];
  });

  it('shows a failure the server recorded, on a fresh load (DOR-2324)', async () => {
    // Purpose: the whole point of the record — reload the page, or open a
    // second window, and the failed listing is still shown.
    record(FAILED);
    renderView({});

    const row = await findRow('my-team');
    expect(
      await within(row).findByText(
        "Its packages didn't load: there's no marketplace listing at that address."
      )
    ).toBeInTheDocument();
    expect(within(row).getByLabelText("Enabled, but its packages didn't load")).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Try again for my-team' })).toBeInTheDocument();
  });

  it('shows an older copy the server is still listing, and when it is from', async () => {
    record({
      state: 'stale',
      checkedAt: '2026-09-24T10:00:00.000Z',
      reason: 'the server at that address refused the connection',
      copyFetchedAt: '2026-09-20T08:00:00.000Z',
      packageCount: 2,
    });
    renderView({});

    const row = await findRow('my-team');
    expect(
      await within(row).findByText(
        `Couldn't reach it: the server at that address refused the connection. Still showing the last copy, from ${when('2026-09-20T08:00:00.000Z')}.`
      )
    ).toBeInTheDocument();
    expect(
      within(row).getByLabelText('Enabled, but showing an older copy of its packages')
    ).toBeInTheDocument();
  });

  it('says a local folder could not be read, rather than reached', async () => {
    record(
      {
        state: 'stale',
        checkedAt: '2026-09-24T10:00:00.000Z',
        reason: "there's no marketplace listing in that folder",
        copyFetchedAt: '2026-09-20T08:00:00.000Z',
        packageCount: 1,
      },
      'file:///Users/me/team-marketplace'
    );
    renderView({});

    const row = await findRow('my-team');
    expect(
      await within(row).findByText(/^Couldn't read that folder: there's no marketplace listing/)
    ).toBeInTheDocument();
  });

  it('shows no note, and a plain Enabled dot, for a listing that loaded', async () => {
    record({ state: 'fetched', checkedAt: 'x', packageCount: 3 });
    renderView({});
    const row = await findRow('my-team');
    expect(within(row).getByLabelText('Enabled')).toBeInTheDocument();
    expect(within(row).queryByText(/didn't load|Couldn't/)).not.toBeInTheDocument();
  });

  it('gives a never-fetched source a neutral dot that says so, and no note', async () => {
    // Purpose: green would claim packages are ready; nothing has been fetched.
    record({ state: 'never' });
    renderView({});
    const row = await findRow('my-team');
    const dot = within(row).getByLabelText('Enabled, not fetched yet');
    expect(dot.getAttribute('class')).not.toMatch(/emerald|amber/);
    expect(within(row).queryByText(/didn't load|Couldn't/)).not.toBeInTheDocument();
  });

  it('says how many packages are ready when the add fetched the listing', async () => {
    const user = userEvent.setup();
    renderView({
      addMarketplaceSource: vi.fn(async () => {
        record({ state: 'fetched', checkedAt: 'x', packageCount: 12 });
        return { ...BASE, listing: { fetched: true, packageCount: 12 } } as AddedMarketplaceSource;
      }),
    });

    await addSource(user);

    const row = await findRow('my-team');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalledWith('Added my-team. 12 packages are ready to install.');
    expect(within(row).getByLabelText('Enabled')).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent('my-team: 12 packages are ready to install.');
  });

  it('warns and announces when the add could not fetch the listing, and the row shows it', async () => {
    const user = userEvent.setup();
    renderView({
      addMarketplaceSource: vi.fn(async () => {
        record(FAILED);
        return {
          ...BASE,
          listing: { fetched: false, reason: "there's no marketplace listing at that address" },
        } as AddedMarketplaceSource;
      }),
    });

    await addSource(user);

    const row = await findRow('my-team');
    expect(await within(row).findByText(/^Its packages didn't load/)).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastWarning).toHaveBeenCalledWith("Added my-team, but its packages didn't load.");
    expect(liveRegion()).toHaveTextContent(
      "my-team: Added, but its packages didn't load: there's no marketplace listing at that address."
    );
  });

  it('clears the note once Try again loads the listing', async () => {
    const user = userEvent.setup();
    record(FAILED);
    const transport = renderView({
      refreshMarketplaceSource: vi.fn(async () => {
        record({ state: 'fetched', checkedAt: 'y', packageCount: 3 });
        return {
          marketplace: { plugins: [{}, {}, {}] },
          fetchedAt: '2026-09-24T10:01:00.000Z',
          stale: false,
        } as RefreshedMarketplaceSource;
      }),
    });

    const row = await findRow('my-team');
    await user.click(await within(row).findByRole('button', { name: 'Try again for my-team' }));

    expect(transport.refreshMarketplaceSource).toHaveBeenCalledWith('my-team');
    expect(toastSuccess).toHaveBeenCalledWith(
      'Refreshed my-team. 3 packages are ready to install.'
    );
    await vi.waitFor(() => expect(within(row).queryByText(/didn't load/)).not.toBeInTheDocument());
    expect(within(row).getByLabelText('Enabled')).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent('my-team: 3 packages are ready to install.');
  });

  it('keeps focus on a busy Refresh, and shows a failed refresh from the server record', async () => {
    const user = userEvent.setup();
    record({ state: 'fetched', checkedAt: 'x', packageCount: 3 });
    let fail!: (err: Error) => void;
    renderView({
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
    record({ ...FAILED, reason: 'the server at that address refused the connection' });
    fail(new Error('the server at that address refused the connection'));

    const note = "Its packages didn't load: the server at that address refused the connection.";
    expect(await within(row).findByText(note)).toBeInTheDocument();
    expect(refresh).toHaveAttribute('aria-busy', 'false');
    expect(toastWarning).toHaveBeenCalledWith("Couldn't refresh my-team.");
    expect(liveRegion()).toHaveTextContent(`my-team: ${note}`);
  });

  it('warns and announces when Refresh could only show the last copy', async () => {
    const user = userEvent.setup();
    record({ state: 'fetched', checkedAt: 'x', packageCount: 2 });
    renderView({
      refreshMarketplaceSource: vi.fn(async () => ({
        marketplace: { plugins: [{}, {}] },
        fetchedAt: '2026-09-20T08:00:00.000Z',
        stale: true,
        reason: 'the server at that address refused the connection',
      })),
    });

    const row = await findRow('my-team');
    await user.click(within(row).getByRole('button', { name: 'Refresh my-team' }));

    await vi.waitFor(() =>
      expect(toastWarning).toHaveBeenCalledWith(
        "Couldn't reach my-team. Still showing the last copy."
      )
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(liveRegion()).toHaveTextContent(
      `my-team: Couldn't reach it: the server at that address refused the connection. Still showing the last copy, from ${when('2026-09-20T08:00:00.000Z')}.`
    );
  });

  it('announces the same failure again when it happens again', async () => {
    // Purpose: a live region only speaks when its content changes.
    const user = userEvent.setup();
    record(FAILED);
    renderView({
      refreshMarketplaceSource: vi.fn().mockRejectedValue(new Error('the server went away')),
    });
    const row = await findRow('my-team');
    const refresh = within(row).getByRole('button', { name: 'Refresh my-team' });

    await user.click(refresh);
    await vi.waitFor(() => expect(liveRegion()).toHaveTextContent(/the server went away/));
    const first = liveRegion().firstElementChild;
    await user.click(refresh);
    await vi.waitFor(() => expect(liveRegion().firstElementChild).not.toBe(first));

    expect(liveRegion()).toHaveTextContent(
      "my-team: Its packages didn't load: the server went away."
    );
  });
});
