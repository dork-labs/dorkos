/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { CatalogEntry } from '@dorkos/shared/relay-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

vi.mock('@/layers/entities/binding', () => ({
  BindingDialog: () => null,
  MoveChatDialog: () => null,
  readChatConflict: () => null,
  toCreateBindingRequest: (value: unknown) => value,
  toUpdateBindingRequest: (value: unknown) => value,
  useCreateBinding: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateBinding: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteBinding: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/layers/entities/mesh', () => ({
  useRegisteredAgents: () => ({ data: { agents: [] } }),
}));

vi.mock('../adapter/AdapterCard', () => ({
  AdapterCard: ({ instance }: { instance: { id: string } }) => (
    <div data-testid={`configured-${instance.id}`} />
  ),
}));
vi.mock('../CatalogCard', () => ({
  CatalogCard: ({ manifest }: { manifest: { displayName: string } }) => (
    <button>{manifest.displayName}</button>
  ),
}));
vi.mock('../AdapterEventLog', () => ({ AdapterEventLog: () => null }));
vi.mock('../AdapterSetupWizard', () => ({ AdapterSetupWizard: () => null }));
vi.mock('../BindingBridgeSection', () => ({ BindingBridgeSection: () => null }));

import { MessagingConnections } from '../MessagingConnections';

afterEach(cleanup);

function renderConnections(transport: Transport) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return render(<MessagingConnections enabled />, { wrapper: Wrapper });
}

function catalogEntry(instances: CatalogEntry['instances'] = []): CatalogEntry {
  return {
    manifest: {
      type: 'telegram',
      displayName: 'Telegram',
      description: 'Message your agents from Telegram',
      category: 'messaging',
      builtin: true,
      configFields: [],
      multiInstance: false,
    },
    instances,
  };
}

const configuredInstance: CatalogEntry['instances'][number] = {
  id: 'telegram-1',
  enabled: true,
  status: {
    id: 'telegram-1',
    type: 'telegram',
    displayName: 'Telegram',
    state: 'connected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  },
};

describe('MessagingConnections catalog states', () => {
  it('shows a failed read honestly and retries into available choices', async () => {
    const user = userEvent.setup();
    const getAdapterCatalog = vi
      .fn()
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValue([catalogEntry()]);
    renderConnections(createMockTransport({ getAdapterCatalog }));

    expect(await screen.findByText('Couldn’t load messaging options')).toBeInTheDocument();
    expect(screen.queryByText(/Pick one below/)).not.toBeInTheDocument();
    expect(screen.queryByText(/using every kind/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('button', { name: 'Telegram' })).toBeInTheDocument();
    await waitFor(() => expect(getAdapterCatalog).toHaveBeenCalledTimes(2));
  });

  it('treats a successful empty catalog as unavailable, not exhausted', async () => {
    renderConnections(createMockTransport({ getAdapterCatalog: vi.fn().mockResolvedValue([]) }));

    expect(await screen.findByText('No messaging options available')).toBeInTheDocument();
    expect(screen.queryByText(/Pick one below/)).not.toBeInTheDocument();
    expect(screen.queryByText(/using every kind/i)).not.toBeInTheDocument();
  });

  it('offers a populated unconfigured catalog below the empty live list', async () => {
    renderConnections(
      createMockTransport({ getAdapterCatalog: vi.fn().mockResolvedValue([catalogEntry()]) })
    );

    expect(await screen.findByText(/Pick one below/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Telegram' })).toBeInTheDocument();
    expect(screen.queryByText(/using every kind/i)).not.toBeInTheDocument();
  });

  it('retains the exhausted message for a populated fully configured catalog', async () => {
    renderConnections(
      createMockTransport({
        getAdapterCatalog: vi.fn().mockResolvedValue([catalogEntry([configuredInstance])]),
      })
    );

    expect(await screen.findByTestId('configured-telegram-1')).toBeInTheDocument();
    expect(screen.getByText(/You are using every kind there is/)).toBeInTheDocument();
    expect(screen.queryByText(/Pick one below/)).not.toBeInTheDocument();
  });
});
