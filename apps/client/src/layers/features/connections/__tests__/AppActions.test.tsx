/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorAppActions } from '@dorkos/shared/connector-resource-schemas';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AppActions, type AppActionsProps } from '../ui/AppActions';
import { ConnectionAccessCard } from '../ui/access/ConnectionAccessCard';

afterEach(cleanup);

const LISTED: ConnectorAppActions = {
  status: 'listed',
  toolkit: 'gmail',
  toolkitVersion: '1',
  complete: true,
  fetchedAt: '2026-09-27T00:00:00.000Z',
  actions: [
    {
      operationSlug: 'GMAIL_FETCH_EMAILS',
      displayName: 'Fetch Emails',
      capabilityClassification: 'read',
      important: true,
    },
    { operationSlug: 'GMAIL_LIST_LABELS', capabilityClassification: 'read', important: false },
    { operationSlug: 'GMAIL_ADD_LABEL', capabilityClassification: 'write', important: false },
    { operationSlug: 'GMAIL_SEND_EMAIL', capabilityClassification: 'destructive', important: true },
  ],
};

function wrap(transport: Transport, children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

function renderActions(
  transport: Transport,
  props: Partial<AppActionsProps> = {}
): ReturnType<typeof render> {
  return wrap(
    transport,
    <AppActions
      toolkit="gmail"
      appName="Gmail"
      providerInstanceId="composio:1"
      level="read-write"
      {...props}
    />
  );
}

function transportWith(result: ConnectorAppActions | Error): Transport {
  const transport = createMockTransport();
  if (result instanceof Error)
    vi.mocked(transport.getConnectorAppActions).mockRejectedValue(result);
  else vi.mocked(transport.getConnectorAppActions).mockResolvedValue(result);
  return transport;
}

describe('AppActions', () => {
  it('shows Look and Change for "Read and write", and says what "Read" keeps', async () => {
    const transport = transportWith(LISTED);
    renderActions(transport);

    const section = await screen.findByTestId('app-actions');
    await waitFor(() => expect(section).toHaveTextContent('With “Read and write”, agents can'));
    expect(within(screen.getByTestId('app-actions-look')).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByTestId('app-actions-look')).toHaveTextContent('Fetch emails');
    expect(screen.getByTestId('app-actions-change')).toHaveTextContent('Add label');
    // A delete-class action is in neither level, so it is not promised here…
    expect(screen.getByTestId('app-actions-change')).not.toHaveTextContent('Send email');
    // …and the panel says how to allow it instead.
    expect(section).toHaveTextContent(
      'Send email isn’t part of either level. To allow it, choose exact actions.'
    );
    expect(section).toHaveTextContent('Pick “Read” and only Look stays.');
    expect(transport.getConnectorAppActions).toHaveBeenCalledWith('gmail', 'composio:1');
  });

  it('keeps only Look on "Read"', async () => {
    renderActions(transportWith(LISTED), { level: 'read' });

    const section = await screen.findByTestId('app-actions');
    await waitFor(() => expect(section).toHaveTextContent('With “Read”, agents can'));
    expect(screen.getByTestId('app-actions-look')).toBeInTheDocument();
    expect(screen.queryByTestId('app-actions-change')).not.toBeInTheDocument();
    expect(section).toHaveTextContent('Pick “Read and write” to also let agents add label.');
  });

  it('opens every action, each tagged Look or Change', async () => {
    const user = userEvent.setup();
    renderActions(transportWith(LISTED));

    await user.click(await screen.findByRole('button', { name: /See all 4 actions/ }));
    const rows = within(screen.getByTestId('app-actions-all')).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Fetch emailsLook',
      'List labelsLook',
      'Add labelChange',
      'Send emailChange',
    ]);
  });

  it('never passes off a partial list as the whole', async () => {
    renderActions(transportWith({ ...LISTED, complete: false }));

    expect(await screen.findByRole('button', { name: /See the first 4 actions/ })).toBeVisible();
    expect(screen.getByTestId('app-actions')).toHaveTextContent(
      'Showing the first 4. Gmail has more than DorkOS can list.'
    );
  });

  it('says plainly when the way reaching the app can’t list its actions', async () => {
    renderActions(transportWith({ status: 'unlisted', toolkit: 'gmail' }));

    expect(
      await screen.findByText(
        'DorkOS can’t list Gmail’s actions, so everything agents do in it counts as a change.'
      )
    ).toBeInTheDocument();
    expect(screen.getByTestId('app-actions')).toHaveTextContent('What agents can do in Gmail');
  });

  it('stays quiet, with no request, when no way to reach the app is set up', () => {
    const transport = transportWith(LISTED);
    renderActions(transport, { providerInstanceId: null, level: null });

    expect(screen.getByTestId('app-actions')).toHaveTextContent(
      'You’ll see what agents can do in Gmail once a way to reach it is set up.'
    );
    expect(transport.getConnectorAppActions).not.toHaveBeenCalled();
  });

  it('treats a way that is no longer set up as the same quiet state', async () => {
    const gone = Object.assign(new Error('Not set up.'), { code: 'provider_not_found' });
    renderActions(transportWith(gone));

    expect(
      await screen.findByText(
        'You’ll see what agents can do in Gmail once a way to reach it is set up.'
      )
    ).toBeInTheDocument();
  });

  it('offers one retry line when the list fails to load', async () => {
    const user = userEvent.setup();
    const transport = transportWith(new Error('upstream'));
    renderActions(transport);

    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(transport.getConnectorAppActions).toHaveBeenCalledTimes(2);
  });
});

describe('AppActions inside the page access card', () => {
  function preview(): ConnectorReconciliationPreview {
    return {
      previewId: 'preview-1',
      connection: {
        connectionId: 'connection-1' as never,
        toolkit: 'gmail',
        label: 'work',
        status: 'active',
        custody: 'managed',
        reconciliationStatus: 'ready',
      },
      candidates: (['read', 'write'] as const).map((classification) => ({
        operationRevisionId: `${classification}-v1`,
        toolkit: 'gmail',
        operationSlug: `gmail.${classification}`,
        toolkitVersion: '1',
        capabilityClassification: classification,
        retryPolicy: 'never' as const,
        inputSchema: {},
        supported: true,
      })),
      agents: [{ agentId: 'agent-ada', displayName: 'Ada' }],
      currentGrants: [],
      everyAgent: { available: true, operationRevisionIds: [] },
      catalogComplete: true,
      createdAt: '2026-09-06T00:00:00.000Z',
      expiresAt: '2099-09-06T01:00:00.000Z',
    };
  }

  it('follows the level switch: picking "Read" leaves only Look', async () => {
    const user = userEvent.setup();
    const transport = transportWith(LISTED);
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
    wrap(
      transport,
      <ConnectionAccessCard
        mode="page"
        variant="embedded"
        connectionId="connection-1"
        serviceName="Gmail"
        appActions={{ toolkit: 'gmail', providerInstanceId: 'composio:1' }}
      />
    );

    await user.click(await screen.findByRole('radio', { name: 'Read and write' }));
    await waitFor(() => expect(screen.getByTestId('app-actions-change')).toBeInTheDocument());
    expect(screen.getByTestId('app-actions')).toHaveTextContent(
      'With “Read and write”, agents can'
    );
    await user.click(screen.getByRole('radio', { name: 'Read' }));
    expect(screen.queryByTestId('app-actions-change')).not.toBeInTheDocument();
    expect(screen.getByTestId('app-actions')).toHaveTextContent('With “Read”, agents can');
  });
});
