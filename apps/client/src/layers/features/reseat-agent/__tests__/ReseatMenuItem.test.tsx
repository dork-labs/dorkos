/**
 * "Continue on another account…" in a member's menu: offered only when the
 * seat has answered here and another account can take it, and otherwise shown
 * disabled with the reason.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReseatOptions } from '@dorkos/shared/room-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { createTestQueryClient } from '@dorkos/test-utils/react-helpers';
import { QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/layers/shared/ui';

import { NOTHING_LEFT } from '../ui/ReseatAgentDialog';
import { ReseatMenuItem } from '../ui/ReseatMenuItem';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => cleanup());

function account(id: string, eligible: boolean): ReseatOptions['accounts'][number] {
  return { id, label: id, color: '#336699', eligible, reason: eligible ? '' : 'Out until 3pm' };
}

/** Render the item inside an open "…" menu, over a transport answering `options`. */
function renderItem(options: ReseatOptions) {
  const transport = createMockTransport({
    getRoomReseatOptions: vi.fn().mockResolvedValue(options),
  });
  const onRequested = vi.fn();
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <TransportProvider transport={transport}>
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger asChild>
            <Button>Ana actions</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <ReseatMenuItem
              roomId="room-1"
              authorId="ana"
              agentName="Ana"
              onRequested={onRequested}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, onRequested };
}

/** The entry, whatever its hint adds to its name. */
function item() {
  return screen.getByRole('menuitem', { name: /Continue on another account…/ });
}

describe('ReseatMenuItem', () => {
  it('is disabled, saying why, when the agent has not answered here yet', async () => {
    const { transport, onRequested } = renderItem({ current: null, accounts: [], seated: false });

    expect(await screen.findByText('Ana hasn’t answered here yet')).toBeInTheDocument();
    expect(item()).toHaveAttribute('data-disabled');
    expect(transport.getRoomReseatOptions).toHaveBeenCalledWith('room-1', 'ana');

    fireEvent.click(item());
    expect(onRequested).not.toHaveBeenCalled();
  });

  it('is disabled, saying why, when no other account can take the agent', async () => {
    const { onRequested } = renderItem({
      current: { id: 'claude4', label: 'Claude4' },
      seated: true,
      accounts: [account('claude3', false)],
    });

    expect(await screen.findByText(NOTHING_LEFT)).toBeInTheDocument();
    expect(item()).toHaveAttribute('data-disabled');

    fireEvent.click(item());
    expect(onRequested).not.toHaveBeenCalled();
  });

  it('opens the picker when another account can take the agent', async () => {
    const { onRequested } = renderItem({
      current: { id: 'claude4', label: 'Claude4' },
      seated: true,
      accounts: [account('claude2', false), account('claude3', true)],
    });

    await waitFor(() => expect(item()).not.toHaveAttribute('data-disabled'));
    expect(screen.queryByText(NOTHING_LEFT)).not.toBeInTheDocument();

    fireEvent.click(item());
    expect(onRequested).toHaveBeenCalledTimes(1);
  });
});
