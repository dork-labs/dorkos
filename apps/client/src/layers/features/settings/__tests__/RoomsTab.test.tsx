/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import { ROOM_TURN_LIMIT_DEFAULTS } from '@dorkos/shared/config-schema';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';
import { RoomsTab } from '../ui/tabs/RoomsTab';

/** The five limits as a stock install reports them, plus the engaged ceilings. */
function stockRooms(overrides: Partial<ServerConfig['rooms']> = {}) {
  return {
    engagedWindowMinutes: 10,
    engagedWindowPosts: 5,
    ...ROOM_TURN_LIMIT_DEFAULTS,
    ...overrides,
  };
}

function renderTab(rooms: ServerConfig['rooms'] = stockRooms()): {
  transport: Transport;
} {
  // Writes land on the fixture, so the invalidate that follows every write
  // refetches what was just written rather than snapping the panel back to the
  // value the reader has already changed.
  const config = { rooms } as unknown as ServerConfig;
  const transport = createMockTransport({
    getConfig: vi.fn().mockImplementation(() => Promise.resolve(config)),
    updateConfig: vi.fn().mockImplementation((patch: { rooms?: object }) => {
      Object.assign(config.rooms ?? {}, patch.rooms ?? {});
      return Promise.resolve(undefined);
    }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(configKeys.current(), config);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  render(<RoomsTab />, { wrapper });
  return { transport };
}

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

  it('says nothing at all until the numbers have been read', () => {
    // A server too old to report the limits at all: the block is on the wire
    // (the engaged ceilings ride it) but says nothing about them.
    renderTab({ engagedWindowMinutes: 10, engagedWindowPosts: 5 });

    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText(/Default: 30/)).not.toBeInTheDocument();
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
