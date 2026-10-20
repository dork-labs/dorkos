/**
 * "Continue on another account…" for an agent in a room: lists where its seat
 * can move, picks the best one that can take it, moves it, and says plainly
 * when nothing has usage left.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ReseatOptions } from '@dorkos/shared/room-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { createTestQueryClient } from '@dorkos/test-utils/react-helpers';
import { QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';

vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({ useIsMobile: () => false }));

import { NOTHING_LEFT, ReseatAgentDialog } from '../ui/ReseatAgentDialog';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => cleanup());

function account(id: string, eligible: boolean, reason = ''): ReseatOptions['accounts'][number] {
  return { id, label: id[0]!.toUpperCase() + id.slice(1), color: '#336699', eligible, reason };
}

function renderDialog(options: ReseatOptions, overrides: Partial<Transport> = {}) {
  const transport = createMockTransport({
    getRoomReseatOptions: vi.fn().mockResolvedValue(options),
    ...overrides,
  });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <ReseatAgentDialog
            open
            onOpenChange={onOpenChange}
            roomId="room-1"
            authorId="ana"
            agentName="ana"
          />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, onOpenChange };
}

describe('ReseatAgentDialog', () => {
  it('offers the best account that can take the agent, and moves it there', async () => {
    const { transport, onOpenChange } = renderDialog({
      current: { id: 'claude4', label: 'Claude4' },
      accounts: [account('claude2', false, 'Almost out of usage'), account('claude3', true)],
    });

    const button = await screen.findByRole('button', { name: 'Continue on Claude3' });
    expect(screen.getByText('ana is on Claude4. Pick where it continues.')).toBeInTheDocument();
    expect(screen.getByText('Almost out of usage')).toBeInTheDocument();

    await userEvent.click(button);

    await waitFor(() =>
      expect(transport.reseatRoomAgent).toHaveBeenCalledWith('room-1', 'ana', {
        account: 'claude3',
      })
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('says no other account has usage left, and offers no move, when none can take it', async () => {
    const { transport } = renderDialog({
      current: { id: 'claude4', label: 'Claude4' },
      accounts: [account('claude3', false, 'Out until Tue 3pm')],
    });

    expect(await screen.findByText(NOTHING_LEFT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(transport.reseatRoomAgent).not.toHaveBeenCalled();
  });

  it('shows why a move was refused, and stays open', async () => {
    const { onOpenChange } = renderDialog(
      { current: null, accounts: [account('claude3', true)] },
      {
        reseatRoomAgent: vi
          .fn()
          .mockRejectedValue(new Error('ana is answering here right now. Move it when it’s done.')),
      }
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Continue on Claude3' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ana is answering here right now');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
