/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import { ROOM_TURN_LIMIT_DEFAULTS } from '@dorkos/shared/config-schema';
import { createMockTransport } from '@dorkos/test-utils';
import { toast } from 'sonner';
import { TransportProvider } from '@/layers/shared/model';
import { createQueryClientConfig } from '@/layers/shared/lib/query-client';
import { configKeys } from '@/layers/entities/config';
import { RoomsTab } from '../ui/tabs/RoomsTab';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** The five limits as a stock install reports them, plus the engaged ceilings. */
function stockRooms(overrides: Partial<ServerConfig['rooms']> = {}) {
  return {
    engagedWindowMinutes: 10,
    engagedWindowPosts: 5,
    ...ROOM_TURN_LIMIT_DEFAULTS,
    ...overrides,
  };
}

/** How a write should behave: land on the fixture, or be refused. */
type WriteMode = 'accept' | { reject: Error };

function renderTab(
  rooms: ServerConfig['rooms'] = stockRooms(),
  write: WriteMode = 'accept'
): {
  transport: Transport;
} {
  // Writes land on the fixture, so the invalidate that follows every write
  // refetches what was just written rather than snapping the panel back to the
  // value the reader has already changed.
  const config = { rooms } as unknown as ServerConfig;
  const transport = createMockTransport({
    getConfig: vi.fn().mockImplementation(() => Promise.resolve(config)),
    updateConfig: vi.fn().mockImplementation((patch: { rooms?: object }) => {
      if (write !== 'accept') return Promise.reject(write.reject);
      Object.assign(config.rooms ?? {}, patch.rooms ?? {});
      return Promise.resolve(undefined);
    }),
  });
  // The REAL error policy, with retries off: the failure report under test is
  // the shared mutation toast, and a hand-rolled client here is how a test that
  // asserts "the person is told" quietly stops asserting anything.
  const queryClient = new QueryClient({
    ...createQueryClientConfig(),
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(configKeys.current(), config);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  render(<RoomsTab />, { wrapper });
  return { transport };
}

/** Render with a config read that fails outright. */
function renderTabWithFailedRead(): void {
  const transport = createMockTransport({
    getConfig: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
  });
  const queryClient = new QueryClient({
    ...createQueryClientConfig(),
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  render(<RoomsTab />, { wrapper });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('RoomsTab', () => {
  it('shows the numbers this install actually holds', () => {
    renderTab(stockRooms({ maxAgentDepth: 7, maxAutomaticTurnsTotalPerHour: 42 }));

    expect(screen.getByRole('spinbutton', { name: 'Replies in a row' })).toHaveValue(7);
    expect(screen.getByRole('spinbutton', { name: 'Replies everywhere each hour' })).toHaveValue(
      42
    );
    expect(screen.getByRole('switch', { name: 'Limit automatic replies' })).toBeChecked();
  });

  it('names the shipped default in the row that can be set away from it', () => {
    renderTab(stockRooms({ maxAgentDepth: 7 }));

    expect(
      screen.getByText(new RegExp(`Default: ${ROOM_TURN_LIMIT_DEFAULTS.maxAgentDepth}\\.`))
    ).toBeInTheDocument();
  });

  it('says so when the server has no such settings, rather than loading forever', async () => {
    // A server too old to report the limits at all: the block is on the wire
    // (the engaged ceilings ride it) but says nothing about them. That is a
    // FINISHED answer, and a skeleton would be a panel waiting on a read that
    // already came back.
    renderTab({ engagedWindowMinutes: 10, engagedWindowPosts: 5 });

    expect(
      await screen.findByText(/This server doesn't report these settings yet/)
    ).toBeInTheDocument();
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText(/Default: 30/)).not.toBeInTheDocument();
  });

  it('says the read failed, rather than loading forever', async () => {
    renderTabWithFailedRead();

    expect(await screen.findByText(/Your settings could not be read just now/)).toBeInTheDocument();
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
  });

  it('turns the limits off, and says what that means', async () => {
    const user = userEvent.setup();
    const { transport } = renderTab();

    expect(screen.queryByText(/The Stop button is the only brake/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Limit automatic replies' }));

    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({ rooms: { turnLimitsEnabled: false } })
    );
    expect(
      await screen.findByText(
        'Agents can reply to each other without limit. The Stop button is the only brake.'
      )
    ).toBeInTheDocument();
  });

  it('keeps every number on screen while the limits are off, and holds them', () => {
    renderTab(stockRooms({ turnLimitsEnabled: false, maxAgentDepth: 7 }));

    const depth = screen.getByRole('spinbutton', { name: 'Replies in a row' });
    expect(depth).toBeDisabled();
    expect(depth).toHaveValue(7);
    for (const field of screen.getAllByRole('spinbutton')) expect(field).toBeDisabled();
  });

  it('writes one number when the reader leaves the field', async () => {
    const user = userEvent.setup();
    const { transport } = renderTab();

    const depth = screen.getByRole('spinbutton', { name: 'Replies in a row' });
    await user.clear(depth);
    await user.type(depth, '12');
    await user.tab();

    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({ rooms: { maxAgentDepth: 12 } })
    );
    expect(transport.updateConfig).toHaveBeenCalledTimes(1);
  });

  it('puts the switch back when the server refuses the write, and says why', async () => {
    // The write is optimistic, so the switch moves before the server has agreed.
    // Two things have to be true when it does not: the switch tells the truth
    // again, and the person is told — by the shared toast, which is the only
    // report that survives Settings being closed mid-write.
    const user = userEvent.setup();
    renderTab(stockRooms(), {
      reject: new Error('Only a person can change those settings'),
    });

    const master = screen.getByRole('switch', { name: 'Limit automatic replies' });
    await user.click(master);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't change that limit",
        expect.objectContaining({ description: 'Only a person can change those settings' })
      )
    );
    await waitFor(() => expect(master).toBeChecked());
    expect(screen.queryByText(/The Stop button is the only brake/)).not.toBeInTheDocument();
  });

  it('refuses a number the schema would refuse, and does not clamp it', async () => {
    const user = userEvent.setup();
    const { transport } = renderTab();

    const depth = screen.getByRole('spinbutton', { name: 'Replies in a row' });
    await user.clear(depth);
    await user.type(depth, '500');
    await user.tab();

    expect(await screen.findByText('Enter a whole number from 0 to 100.')).toBeInTheDocument();
    expect(transport.updateConfig).not.toHaveBeenCalled();
    expect(depth).toHaveValue(500);
  });
});
