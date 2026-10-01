/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CatalogEntry, CatalogInstance } from '@dorkos/shared/relay-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ChatAppPanel } from '../ui/ChatAppPanel';

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useEventSubscription: () => {},
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

function instance(over: Partial<CatalogInstance> = {}): CatalogInstance {
  return {
    id: 'telegram-1',
    enabled: true,
    label: '@lifeos_bot',
    status: {
      id: 'telegram-1',
      type: 'telegram',
      displayName: 'Telegram',
      state: 'connected',
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
    },
    ...over,
  };
}

function entry(bot: CatalogInstance, multiInstance = true): CatalogEntry {
  return {
    manifest: {
      type: 'telegram',
      displayName: 'Telegram',
      description: 'Telegram bots.',
      category: 'messaging',
      builtin: true,
      multiInstance,
      configFields: [],
    },
    instances: [bot],
  };
}

function renderPanel(bot: CatalogInstance, multiInstance = true) {
  const transport: Transport = createMockTransport({
    getBindings: vi.fn().mockResolvedValue([]),
    listMeshAgents: vi.fn().mockResolvedValue({ agents: [{ id: 'dorkbot', name: 'DorkBot' }] }),
    getAdapterEvents: vi.fn().mockResolvedValue({ events: [] }),
    listUnclaimedChats: vi.fn().mockResolvedValue([]),
    toggleRelayAdapter: vi.fn().mockResolvedValue({ ok: true }),
    removeRelayAdapter: vi.fn().mockResolvedValue({ ok: true }),
  });
  const onClose = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <TransportProvider transport={transport}>
        <ChatAppPanel entry={entry(bot, multiInstance)} instance={bot} onClose={onClose} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, onClose };
}

describe('ChatAppPanel', () => {
  it('asks who answers, and folds the bot’s settings under More', async () => {
    const user = userEvent.setup();
    renderPanel(instance());

    expect(screen.getByRole('heading', { name: 'Who answers' })).toBeInTheDocument();
    expect(screen.queryByTestId('app-panel-fix')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More' }));
    const more = screen.getByTestId('app-panel-more');
    expect(within(more).getByRole('button', { name: /^Settings/ })).toBeInTheDocument();
    expect(
      within(more).getByRole('button', { name: /Set up another Telegram/ })
    ).toBeInTheDocument();
  });

  it('puts Resume on top of a paused bot, and resumes it', async () => {
    const user = userEvent.setup();
    const { transport } = renderPanel(instance({ enabled: false }));

    const fix = screen.getByTestId('app-panel-fix');
    expect(fix).toHaveTextContent('Paused. No messages go in or out of Telegram.');
    await user.click(within(fix).getByRole('button', { name: 'Resume' }));
    await waitFor(() =>
      expect(transport.toggleRelayAdapter).toHaveBeenCalledWith('telegram-1', true)
    );
  });

  it('shows a failed bot in plain words, its raw error only under Details, with its settings one click away', async () => {
    const user = userEvent.setup();
    renderPanel(
      instance({
        status: { ...instance().status, state: 'error', lastError: 'Bot token was revoked' },
      })
    );

    const fix = screen.getByTestId('app-panel-fix');
    expect(fix).toHaveTextContent('Stopped working. Messages aren’t getting through Telegram.');
    expect(fix).not.toHaveTextContent('Bot token was revoked');
    // The raw error waits under a collapsed Details for a bug report.
    await user.click(within(fix).getByRole('button', { name: 'Details' }));
    expect(within(fix).getByText('Bot token was revoked')).toBeVisible();
    await user.click(within(fix).getByRole('button', { name: 'Check its settings' }));
    expect(await screen.findByRole('dialog', { name: /Edit Telegram/ })).toBeInTheDocument();
  });

  it('asks before removing the bot, then closes', async () => {
    const user = userEvent.setup();
    const { transport, onClose } = renderPanel(instance(), false);

    await user.click(screen.getByRole('button', { name: 'More' }));
    const more = screen.getByTestId('app-panel-more');
    expect(within(more).queryByRole('button', { name: /Set up another/ })).not.toBeInTheDocument();
    await user.click(within(more).getByRole('button', { name: /Remove…/ }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove Telegram?' });
    // Removing deletes its delivery records (DOR-2604) and every chat it
    // recorded, blocked and ignored ones included (DOR-2608), with the names
    // in them, so the dialog says so.
    expect(confirm).toHaveAccessibleDescription(
      /So are its recent deliveries and its list of people who messaged it with no agent to answer, ignored and blocked ones included, with their names\..*anyone you blocked there will need blocking again\./
    );
    expect(transport.removeRelayAdapter).not.toHaveBeenCalled();
    const feedReadsBefore = vi.mocked(transport.listUnclaimedChats).mock.calls.length;
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(transport.removeRelayAdapter).toHaveBeenCalledWith('telegram-1'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // The server deleted its waiting chats too (DOR-2608), so the feed is read again.
    await waitFor(() =>
      expect(vi.mocked(transport.listUnclaimedChats).mock.calls.length).toBeGreaterThan(
        feedReadsBefore
      )
    );
  });
});
