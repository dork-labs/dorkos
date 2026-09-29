/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import { createMockTransport, createMockConnectionReadiness } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  ConnectionAccessCard,
  type ConnectionAccessCardProps,
} from '../ui/access/ConnectionAccessCard';

afterEach(cleanup);

function candidate(id: string, classification: 'read' | 'write' | 'destructive') {
  return {
    operationRevisionId: id,
    toolkit: 'gmail',
    operationSlug: `gmail.${id}`,
    toolkitVersion: '1',
    capabilityClassification: classification,
    retryPolicy: 'never' as const,
    inputSchema: {},
    supported: true,
  };
}

const AGENTS = ['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Flo', 'Gus'].map((name) => ({
  agentId: `agent-${name.toLowerCase()}`,
  displayName: name,
}));

function preview(
  currentGrants: ConnectorReconciliationPreview['currentGrants'] = [],
  connectionId = 'connection-1'
): ConnectorReconciliationPreview {
  return {
    previewId: `preview-${connectionId}`,
    connection: {
      connectionId: connectionId as never,
      toolkit: 'gmail',
      label: connectionId === 'connection-2' ? 'personal' : 'work',
      status: 'active',
      custody: 'managed',
      reconciliationStatus: 'ready',
    },
    candidates: [
      candidate('read-v1', 'read'),
      candidate('send-v1', 'write'),
      candidate('delete-v1', 'destructive'),
    ],
    agents: AGENTS,
    currentGrants,
    everyAgent: { available: true, operationRevisionIds: [] },
    catalogComplete: true,
    createdAt: '2026-09-06T00:00:00.000Z',
    expiresAt: '2099-09-06T01:00:00.000Z',
  };
}

function account(connectionId: string, label: string): ConnectorConnectionSummary {
  return {
    connectionId: connectionId as never,
    providerInstanceId: 'managed-1' as never,
    toolkit: 'gmail',
    label,
    identityHint: `${label}@example.com`,
    lifecycle: 'connected',
    authenticationStatus: 'active',
    reconciliationStatus: 'ready',
    authoritySync: { status: 'ready' },
    mode: 'managed',
    custody: 'managed',
    payer: 'dorkos_managed',
    agentCount: 0,
    everyAgent: null,
    subscriptionCount: 0,
    usage: { status: 'available', logicalOperationCount: 0, attemptCount: 0 },
    readiness: createMockConnectionReadiness(),
  };
}

function renderCard(transport: Transport, props: ConnectionAccessCardProps) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <ConnectionAccessCard {...props} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('ConnectionAccessCard — page mode', () => {
  it('lists the most relevant agents first and saves only the picked agent at the chosen preset', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview([{ agentId: 'agent-gus', operationRevisionIds: ['read-v1'] }])
    );
    vi.mocked(transport.listMeshAgents).mockResolvedValue({
      agents: [{ id: 'agent-flo', isSystem: true }],
    } as never);
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-1' as never,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'ready' },
      grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1', 'send-v1'] }],
    });
    const onFinished = vi.fn();
    renderCard(transport, {
      mode: 'page',
      connectionId: 'connection-1',
      serviceName: 'Gmail',
      onFinished,
      onSkip: vi.fn(),
    });

    expect(await screen.findByRole('heading', { name: 'Who can use Gmail?' })).toBeInTheDocument();
    // Gus already has access, Flo is a system agent; five show before "Show all".
    await waitFor(() =>
      expect(screen.getAllByRole('checkbox').map((box) => box.id.split('-').at(-1))).toEqual([
        'gus',
        'flo',
        'ada',
        'bo',
        'cy',
      ])
    );
    expect(screen.getByRole('checkbox', { name: 'Gus' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Show all 7' }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(7);

    await user.click(screen.getByRole('checkbox', { name: 'Bo' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
        previewId: 'preview-connection-1',
        grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'] }],
      })
    );
    // The server answered with different grants than were sent: never success.
    expect(await screen.findByText(/couldn’t confirm that access was saved/i)).toBeInTheDocument();
    expect(screen.queryByText('Access updated')).not.toBeInTheDocument();
  });

  it('upgrades picked agents when the level changes and reports the confirmed result', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-1' as never,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'ready' },
      grants: [{ agentId: 'agent-ada', operationRevisionIds: ['read-v1', 'send-v1'] }],
    });
    const onFinished = vi.fn();
    renderCard(transport, {
      mode: 'page',
      connectionId: 'connection-1',
      serviceName: 'Gmail',
      onFinished,
    });

    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Ada' }));
    await user.click(screen.getByRole('radio', { name: 'Read and write' }));
    await user.click(save);

    expect(await screen.findByTestId('connector-access-outcome')).toHaveTextContent(
      'Access updated'
    );
    expect(screen.getByText('Ada can use Gmail.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending sync unusable until an explicit check, without repeating the write', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-1' as never,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'pending' },
      grants: [{ agentId: 'agent-ada', operationRevisionIds: ['read-v1'] }],
    });
    vi.mocked(transport.getConnectorConnection).mockRejectedValue(new Error('offline'));
    renderCard(transport, { mode: 'page', connectionId: 'connection-1', serviceName: 'Gmail' });

    await user.click(await screen.findByRole('checkbox', { name: 'Ada' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByTestId('connector-access-outcome')).toHaveTextContent(
      'Access update pending'
    );
    await user.click(screen.getByRole('button', { name: 'Check if it’s done' }));
    expect(await screen.findByText(/DorkOS didn’t send it again/)).toBeInTheDocument();
    expect(screen.queryByText('Access updated')).not.toBeInTheDocument();
    expect(transport.applyConnectorReconciliation).toHaveBeenCalledTimes(1);
  });

  it('opens the exact action editor for this account', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
    const onEditExactActions = vi.fn();
    renderCard(transport, {
      mode: 'page',
      connectionId: 'connection-1',
      serviceName: 'Gmail',
      onEditExactActions,
    });
    await user.click(await screen.findByRole('button', { name: 'Choose exact actions' }));
    expect(onEditExactActions).toHaveBeenCalledWith('connection-1');
  });
});

describe('ConnectionAccessCard — one agent', () => {
  it('asks which account first when two are connected, then grants only that agent', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorConnections).mockResolvedValue({
      connections: [account('connection-1', 'work'), account('connection-2', 'personal')],
    });
    vi.mocked(transport.previewConnectorReconciliation).mockImplementation(
      async ({ connectionId }) => preview([], connectionId)
    );
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-2' as never,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'ready' },
      grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1', 'send-v1'] }],
    });
    renderCard(transport, {
      mode: 'agent',
      agentId: 'agent-bo',
      toolkit: 'gmail',
      serviceName: 'Gmail',
      onSkip: vi.fn(),
    });

    expect(
      await screen.findByRole('heading', { name: 'Which Gmail account?' })
    ).toBeInTheDocument();
    expect(transport.previewConnectorReconciliation).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('radio', { name: /personal/ }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Let Bo use Gmail?' })).toBeInTheDocument();
    expect(transport.previewConnectorReconciliation).toHaveBeenCalledWith({
      connectionId: 'connection-2',
    });
    expect(screen.queryByRole('button', { name: /Allow once/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Read and write' }));
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
        previewId: 'preview-connection-2',
        grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1', 'send-v1'] }],
      })
    );
    expect(await screen.findByText('Bo can read and write in Gmail.')).toBeInTheDocument();
  });

  it('goes straight to the question with one account and never overwrites exact actions', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorConnections).mockResolvedValue({
      connections: [account('connection-1', 'work')],
    });
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview([{ agentId: 'agent-bo', operationRevisionIds: ['read-v1', 'delete-v1'] }])
    );
    renderCard(transport, {
      mode: 'agent',
      agentId: 'agent-bo',
      toolkit: 'gmail',
      serviceName: 'Gmail',
    });

    expect(await screen.findByText(/already has exact actions chosen/)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
  });

  it('says so when the app has no connected account', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorConnections).mockResolvedValue({ connections: [] });
    renderCard(transport, {
      mode: 'agent',
      agentId: 'agent-bo',
      toolkit: 'gmail',
      serviceName: 'Gmail',
    });
    expect(await screen.findByText('No Gmail account is ready to use yet.')).toBeInTheDocument();
  });
});

describe('ConnectionAccessCard — deciding for one agent never touches anyone else', () => {
  const OTHERS: ConnectorReconciliationPreview['currentGrants'] = [
    { agentId: 'agent-ada', operationRevisionIds: ['read-v1'] },
    { agentId: 'agent-gus', operationRevisionIds: ['read-v1', 'delete-v1'] },
  ];

  it('writes exactly one grant, for the fixed agent, while others hold preset and exact access', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview(OTHERS));
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-1' as never,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'ready' },
      grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'] }],
    });
    renderCard(transport, {
      mode: 'agent',
      agentId: 'agent-bo',
      toolkit: 'gmail',
      connectionId: 'connection-1',
      serviceName: 'Gmail',
    });

    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(transport.applyConnectorReconciliation).toHaveBeenCalledTimes(1));
    expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
      previewId: 'preview-connection-1',
      grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'] }],
    });
    expect(await screen.findByText('Bo can read Gmail.')).toBeInTheDocument();
  });

  it('keeps Allow disabled when nothing would change for the fixed agent', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview([...OTHERS, { agentId: 'agent-bo', operationRevisionIds: ['read-v1'] }])
    );
    renderCard(transport, {
      mode: 'agent',
      agentId: 'agent-bo',
      toolkit: 'gmail',
      connectionId: 'connection-1',
      serviceName: 'Gmail',
    });
    expect(await screen.findByText('Bo can already do this.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
  });

  it('never offers a lower level than the agent already holds', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview([{ agentId: 'agent-bo', operationRevisionIds: ['read-v1', 'send-v1'] }])
    );
    renderCard(transport, {
      mode: 'agent',
      agentId: 'agent-bo',
      toolkit: 'gmail',
      connectionId: 'connection-1',
      serviceName: 'Gmail',
    });
    expect(await screen.findByText('Bo can already do this.')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Read' })).not.toBeInTheDocument();
    expect(screen.getByText('Read and write')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
  });

  it('keeps Allow disabled for an agent that is not registered here', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview(OTHERS));
    renderCard(transport, {
      mode: 'agent',
      agentId: 'agent-unknown',
      toolkit: 'gmail',
      connectionId: 'connection-1',
      serviceName: 'Gmail',
    });
    expect(await screen.findByText(/isn’t registered/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
  });
});

describe('ConnectionAccessCard — answering a chat request (onAllowed)', () => {
  it('reports the account only after the server confirmed the saved access', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-1' as never,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'pending' },
      grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'] }],
    });
    const onAllowed = vi.fn();
    renderCard(transport, {
      mode: 'agent',
      agentId: 'agent-bo',
      toolkit: 'gmail',
      connectionId: 'connection-1',
      serviceName: 'Gmail',
      onAllowed,
    });

    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    // Saved, but still being applied: not usable yet, so not reported, even
    // after every effect the save caused has run.
    expect(await screen.findByText('Access update pending')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onAllowed).not.toHaveBeenCalled();
  });

  it('does not report a save the operation catalog moved under', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-1' as never,
      reconciliationStatus: 'migration_needs_reconcile',
      authoritySync: { status: 'ready' },
      grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'] }],
    });
    const onAllowed = vi.fn();
    renderCard(transport, {
      mode: 'agent',
      agentId: 'agent-bo',
      toolkit: 'gmail',
      connectionId: 'connection-1',
      serviceName: 'Gmail',
      onAllowed,
    });

    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    expect(await screen.findByText('Access needs review')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onAllowed).not.toHaveBeenCalled();
  });

  it('reports a confirmed save once', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-1' as never,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'ready' },
      grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'] }],
    });
    const onAllowed = vi.fn();
    renderCard(transport, {
      mode: 'agent',
      agentId: 'agent-bo',
      toolkit: 'gmail',
      connectionId: 'connection-1',
      serviceName: 'Gmail',
      onAllowed,
    });

    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(onAllowed).toHaveBeenCalledWith('connection-1'));
    expect(onAllowed).toHaveBeenCalledTimes(1);
  });

  it('answers with access the agent already holds, writing nothing', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview([{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'] }])
    );
    const onAllowed = vi.fn();
    renderCard(transport, {
      mode: 'agent',
      agentId: 'agent-bo',
      toolkit: 'gmail',
      connectionId: 'connection-1',
      serviceName: 'Gmail',
      onAllowed,
    });

    expect(await screen.findByText('Bo can already do this.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onAllowed).toHaveBeenCalledWith('connection-1');
    expect(transport.applyConnectorReconciliation).not.toHaveBeenCalled();
  });

  it('still refuses an agent that holds nothing and is not registered here', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
    renderCard(transport, {
      mode: 'agent',
      agentId: 'agent-unknown',
      toolkit: 'gmail',
      connectionId: 'connection-1',
      serviceName: 'Gmail',
      onAllowed: vi.fn(),
    });
    expect(await screen.findByText(/isn’t registered/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
  });
});

describe('ConnectionAccessCard — removals and mixed access are visible before saving', () => {
  it('says who will lose access before Save and after it', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview([
        { agentId: 'agent-ada', operationRevisionIds: ['read-v1'] },
        { agentId: 'agent-gus', operationRevisionIds: ['read-v1', 'delete-v1'] },
      ])
    );
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-1' as never,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'ready' },
      grants: [{ agentId: 'agent-gus', operationRevisionIds: [] }],
    });
    renderCard(transport, { mode: 'page', connectionId: 'connection-1', serviceName: 'Gmail' });

    expect(await screen.findByLabelText('Now: Exact actions')).toBeInTheDocument();
    expect(screen.queryByText(/will lose access/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Gus' }));
    expect(screen.getByRole('checkbox', { name: 'Gus' })).toHaveAccessibleDescription(
      'Gus will lose access to Gmail.'
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
        previewId: 'preview-connection-1',
        grants: [{ agentId: 'agent-gus', operationRevisionIds: [] }],
      })
    );
    expect(
      await screen.findByText('Ada can use Gmail. Gus can no longer use it.')
    ).toBeInTheDocument();
  });

  it('shows each current level, selects no level while they differ, and only changes them on an explicit pick', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview([
        { agentId: 'agent-ada', operationRevisionIds: ['read-v1', 'send-v1'] },
        { agentId: 'agent-bo', operationRevisionIds: ['read-v1'] },
      ])
    );
    vi.mocked(transport.applyConnectorReconciliation).mockImplementation(async (request) => ({
      connectionId: 'connection-1' as never,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'ready' },
      grants: request.grants,
    }));
    renderCard(transport, { mode: 'page', connectionId: 'connection-1', serviceName: 'Gmail' });

    expect(await screen.findByLabelText('Now: Read and write')).toBeInTheDocument();
    expect(screen.getByLabelText('Now: Read')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Read' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Read and write' })).not.toBeChecked();
    expect(screen.getByText(/Your agents have different access/)).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    // Adding someone while the level is mixed still needs an explicit level.
    await user.click(screen.getByRole('checkbox', { name: 'Cy' }));
    expect(save).toBeDisabled();

    expect(screen.queryByText('Ada will lose write access.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Read' }));
    expect(screen.getByRole('checkbox', { name: 'Ada' })).toHaveAccessibleDescription(
      'Ada will lose write access.'
    );
    await user.click(save);
    await waitFor(() =>
      expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
        previewId: 'preview-connection-1',
        grants: [
          { agentId: 'agent-ada', operationRevisionIds: ['read-v1'] },
          { agentId: 'agent-cy', operationRevisionIds: ['read-v1'] },
        ],
      })
    );
    expect(await screen.findByTestId('connector-access-outcome')).toHaveTextContent(
      'Access updated'
    );
    expect(
      screen.getByText('Ada, Bo and Cy can use Gmail. Ada can now only read.')
    ).toBeInTheDocument();
  });

  it('will not save a removal alone while a newly ticked agent still has no level', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview([
        { agentId: 'agent-ada', operationRevisionIds: ['read-v1', 'send-v1'] },
        { agentId: 'agent-bo', operationRevisionIds: ['read-v1'] },
      ])
    );
    renderCard(transport, { mode: 'page', connectionId: 'connection-1', serviceName: 'Gmail' });

    await user.click(await screen.findByRole('checkbox', { name: 'Cy' }));
    await user.click(screen.getByRole('checkbox', { name: 'Bo' }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.click(save);
    expect(transport.applyConnectorReconciliation).not.toHaveBeenCalled();
    await user.click(screen.getByRole('radio', { name: 'Read and write' }));
    expect(save).toBeEnabled();
  });

  it('keeps every agent with access in view, even after unticking it', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    const withAccess = ['ada', 'bo', 'cy', 'di', 'ed', 'flo'];
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview(
        withAccess.map((name) => ({
          agentId: `agent-${name}`,
          operationRevisionIds: ['read-v1'],
        }))
      )
    );
    renderCard(transport, { mode: 'page', connectionId: 'connection-1', serviceName: 'Gmail' });

    await user.click(await screen.findByRole('checkbox', { name: 'Flo' }));
    expect(screen.getByRole('checkbox', { name: 'Flo' })).not.toBeChecked();
    expect(screen.getByText('Flo will lose access to Gmail.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Gus' })).not.toBeInTheDocument();
  });
});

describe('ConnectionAccessCard — ways out', () => {
  it('keeps the exact action editor reachable when access cannot be loaded', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockRejectedValue(new Error('offline'));
    const onEditExactActions = vi.fn();
    renderCard(transport, {
      mode: 'page',
      connectionId: 'connection-1',
      serviceName: 'Gmail',
      onEditExactActions,
    });
    expect(await screen.findByText('Couldn’t load who can use it')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choose exact actions' }));
    expect(onEditExactActions).toHaveBeenCalledWith('connection-1');
  });

  it('returns to the question after a save when the card has nowhere to close to', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-1' as never,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'ready' },
      grants: [{ agentId: 'agent-ada', operationRevisionIds: ['read-v1'] }],
    });
    renderCard(transport, { mode: 'page', connectionId: 'connection-1', serviceName: 'Gmail' });

    await user.click(await screen.findByRole('checkbox', { name: 'Ada' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: 'Edit again' }));
    expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(transport.previewConnectorReconciliation).toHaveBeenCalledTimes(2);
  });
});
