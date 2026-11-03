/**
 * @vitest-environment jsdom
 */
/**
 * The DM view and Show sessions in Settings › Advanced (DOR-3074), through the
 * real config read and write path. The DM view is the way back, so it is always
 * drawn; Show sessions is drawn only while the DM view is on.
 */
import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ExperimentsTab } from '../ui/ExperimentsTab';

const DM_VIEW_LABEL = 'Chats with one agent read like a DM';

let updateConfig: Mock<(patch: Record<string, unknown>) => Promise<void>>;

/** Mount the tab over a config with the DM view on or off. */
function renderTab(dmView: boolean, showSessions = false): void {
  updateConfig = vi.fn().mockResolvedValue(undefined);
  const transport: Transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      ui: { dmView, showSessions },
    }),
    updateConfig,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ExperimentsTab />
      </TransportProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
});

describe('Show sessions', () => {
  it('is not drawn while the DM view is off, because it would change nothing', async () => {
    renderTab(false);
    expect(await screen.findByRole('switch', { name: DM_VIEW_LABEL })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Show sessions' })).not.toBeInTheDocument();
  });

  it('is drawn beside Show dev tools while the DM view is on, and writes ui.showSessions', async () => {
    const user = userEvent.setup();
    renderTab(true);

    const toggle = await screen.findByRole('switch', { name: 'Show sessions' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/working session behind each chat/)).toBeInTheDocument();

    await user.click(toggle);

    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ ui: { showSessions: true } }));
  });

  it('shows the saved position', async () => {
    renderTab(true, true);
    expect(await screen.findByRole('switch', { name: 'Show sessions' })).toBeChecked();
  });
});

describe('The DM view switch', () => {
  it('is on when the config says so, and turning it off writes ui.dmView', async () => {
    const user = userEvent.setup();
    renderTab(true);

    const toggle = await screen.findByRole('switch', { name: DM_VIEW_LABEL });
    await waitFor(() => expect(toggle).toBeChecked());

    await user.click(toggle);

    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ ui: { dmView: false } }));
  });

  it('can turn it back on after it was turned off', async () => {
    const user = userEvent.setup();
    renderTab(false);

    await user.click(await screen.findByRole('switch', { name: DM_VIEW_LABEL }));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ ui: { dmView: true } }));
  });
});
