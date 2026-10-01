/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorAppActions } from '@dorkos/shared/connector-resource-schemas';
import type {
  ConnectorOperationClassification,
  ConnectorReconciliationCandidate,
  ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { SETTINGS_RELINK_SECTION, TransportProvider } from '@/layers/shared/model';

const openSettings = vi.hoisted(() => vi.fn());
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSettingsDeepLink: () => ({ open: openSettings }),
}));
import { AppActions, type AppActionsProps } from '../ui/AppActions';
import { ConnectionAccessCard } from '../ui/access/ConnectionAccessCard';

afterEach(cleanup);

const LISTED: ConnectorAppActions = {
  status: 'listed',
  toolkit: 'gmail',
  toolkitVersion: '2',
  completeness: 'complete',
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
    {
      operationSlug: 'GMAIL_DELETE_MESSAGE',
      capabilityClassification: 'destructive',
      important: true,
    },
  ],
};

function candidate(
  operationSlug: string,
  capabilityClassification: ConnectorOperationClassification,
  extra: Partial<ConnectorReconciliationCandidate> = {}
): ConnectorReconciliationCandidate {
  return {
    operationRevisionId: `${operationSlug}-${extra.toolkitVersion ?? '2'}`,
    toolkit: 'gmail',
    operationSlug,
    toolkitVersion: '2',
    capabilityClassification,
    retryPolicy: 'never',
    inputSchema: {},
    supported: true,
    ...extra,
  };
}

/** The grant snapshot that matches {@link LISTED}. */
const CANDIDATES = [
  candidate('GMAIL_FETCH_EMAILS', 'read'),
  candidate('GMAIL_LIST_LABELS', 'read'),
  candidate('GMAIL_ADD_LABEL', 'write'),
  candidate('GMAIL_DELETE_MESSAGE', 'destructive'),
];

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

function renderActions(transport: Transport, props: Partial<AppActionsProps> = {}) {
  return wrap(
    transport,
    <AppActions toolkit="gmail" appName="Gmail" providerInstanceId="composio:1" {...props} />
  );
}

function transportWith(result: ConnectorAppActions | Error): Transport {
  const transport = createMockTransport();
  if (result instanceof Error)
    vi.mocked(transport.getConnectorAppActions).mockRejectedValue(result);
  else vi.mocked(transport.getConnectorAppActions).mockResolvedValue(result);
  return transport;
}

describe('AppActions on a connected account', () => {
  it('shows Look and Change for "Read and write", and says what "Read" keeps', async () => {
    const transport = transportWith(LISTED);
    renderActions(transport, { grant: { candidates: CANDIDATES, level: 'read-write' } });

    const section = screen.getByTestId('app-actions');
    await waitFor(() =>
      expect(screen.getByTestId('app-actions-look')).toHaveTextContent('Fetch emails')
    );
    expect(section).toHaveTextContent('With “Read and write”, agents can');
    expect(within(screen.getByTestId('app-actions-look')).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByTestId('app-actions-change')).toHaveTextContent('Add label');
    // A delete-class action is in neither level, so it is not promised here…
    expect(screen.getByTestId('app-actions-change')).not.toHaveTextContent('Delete message');
    // …and the panel says how to allow it instead.
    expect(section).toHaveTextContent(
      'Delete message isn’t part of either level. To allow it, choose exact actions.'
    );
    expect(section).toHaveTextContent('Pick “Read” and only Look stays.');
    expect(transport.getConnectorAppActions).toHaveBeenCalledWith('gmail', 'composio:1');
  });

  it('keeps only Look on "Read"', async () => {
    renderActions(transportWith(LISTED), { grant: { candidates: CANDIDATES, level: 'read' } });

    const section = screen.getByTestId('app-actions');
    await waitFor(() => expect(section).toHaveTextContent('With “Read”, agents can'));
    await waitFor(() => expect(screen.getByTestId('app-actions-look')).toBeInTheDocument());
    expect(screen.queryByTestId('app-actions-change')).not.toBeInTheDocument();
    expect(section).toHaveTextContent('Pick “Read and write” to also let agents add label.');
  });

  it('follows the grant snapshot, not the list: an older version and a disagreeing classification', async () => {
    const user = userEvent.setup();
    renderActions(transportWith(LISTED), {
      grant: {
        level: 'read',
        candidates: [
          candidate('GMAIL_FETCH_EMAILS', 'read'),
          // The list says Look; this account's snapshot says Change. The snapshot wins.
          candidate('GMAIL_LIST_LABELS', 'write'),
          // An older version the review still carries, which the list doesn't have.
          candidate('GMAIL_LEGACY_SEARCH', 'read', { toolkitVersion: '1' }),
          // Not grantable any more, so never shown.
          candidate('GMAIL_GONE', 'read', { supported: false }),
        ],
      },
    });

    const look = await screen.findByTestId('app-actions-look');
    await waitFor(() => expect(look).toHaveTextContent('Fetch emails'));
    expect(look).toHaveTextContent('Legacy search');
    expect(look).not.toHaveTextContent('List labels');
    expect(look).not.toHaveTextContent('Gone');
    expect(screen.getByTestId('app-actions')).toHaveTextContent(
      'Pick “Read and write” to also let agents list labels.'
    );
    await user.click(screen.getByRole('button', { name: /See all 3 actions/ }));
    const rows = within(screen.getByTestId('app-actions-all')).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Fetch emailsLook',
      'List labelsChange',
      'Legacy searchLook',
    ]);
  });

  it('still shows the snapshot, with names read from ids, when the list fails', async () => {
    renderActions(transportWith(new Error('upstream')), {
      grant: { candidates: CANDIDATES, level: 'read' },
    });

    await waitFor(() =>
      expect(screen.getByTestId('app-actions-look')).toHaveTextContent('Fetch emails')
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

describe('AppActions before an app is connected', () => {
  it('describes what the app offers, each change tagged, with no level promised', async () => {
    const user = userEvent.setup();
    renderActions(transportWith(LISTED));

    await user.click(await screen.findByRole('button', { name: /See all 4 actions/ }));
    expect(screen.getByTestId('app-actions')).toHaveTextContent('What Gmail offers agents');
    expect(screen.getByTestId('app-actions-change')).toHaveTextContent('Delete message');
    const rows = within(screen.getByTestId('app-actions-all')).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Fetch emailsLook',
      'List labelsLook',
      'Add labelChange',
      'Delete messageChange',
    ]);
  });

  it('says why a list is partial, and never passes it off as the whole', async () => {
    renderActions(transportWith({ ...LISTED, completeness: 'too_large' }));
    expect(await screen.findByRole('button', { name: /See the first 4 actions/ })).toBeVisible();
    expect(screen.getByTestId('app-actions')).toHaveTextContent(
      'Showing the first 4. Gmail has more actions than DorkOS lists.'
    );
    cleanup();

    renderActions(transportWith({ ...LISTED, completeness: 'interrupted' }));
    expect(await screen.findByRole('button', { name: /See the first 4 actions/ })).toBeVisible();
    expect(screen.getByTestId('app-actions')).toHaveTextContent(
      'Showing the first 4. The rest didn’t load this time.'
    );
  });

  it('says plainly when the way reaching the app can’t list its actions', async () => {
    renderActions(transportWith({ status: 'unlisted', toolkit: 'gmail' }));

    expect(
      await screen.findByText(
        'DorkOS can’t list Gmail’s actions, so everything agents do in it counts as a change.'
      )
    ).toBeInTheDocument();
  });

  it('stays quiet, with no request, when there is no way to ask', () => {
    const transport = transportWith(LISTED);
    renderActions(transport, { providerInstanceId: null });

    expect(screen.getByTestId('app-actions')).toHaveTextContent(
      'You’ll see what Gmail offers agents once DorkOS can reach it.'
    );
    expect(transport.getConnectorAppActions).not.toHaveBeenCalled();
  });

  it('treats a way that is no longer set up as the same quiet state', async () => {
    const gone = Object.assign(new Error('Not set up.'), { code: 'provider_not_found' });
    renderActions(transportWith(gone));

    expect(
      await screen.findByText('You’ll see what Gmail offers agents once DorkOS can reach it.')
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

describe('AppActions when a DorkOS account problem stops the list', () => {
  it('names the problem and offers to link again, one click from the list', async () => {
    const user = userEvent.setup();
    const refusal = Object.assign(new Error('x'), { code: 'cloud_link_needs_update' });
    renderActions(transportWith(refusal));

    expect(await screen.findByText(/This computer’s link needs updating\./)).toBeInTheDocument();
    expect(screen.getByText(/pick up the update/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Link my DorkOS account again' }));
    expect(openSettings).toHaveBeenCalledWith('access', SETTINGS_RELINK_SECTION);
  });

  it('names a refusal on DorkOS’s end with its title, and offers only a retry', async () => {
    const refusal = Object.assign(new Error('x'), { code: 'cloud_refused' });
    renderActions(transportWith(refusal));

    expect(
      await screen.findByText(/DorkOS’s servers couldn’t finish this\. Nothing changed/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Link my DorkOS account again' })
    ).not.toBeInTheDocument();
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
      candidates: CANDIDATES,
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
