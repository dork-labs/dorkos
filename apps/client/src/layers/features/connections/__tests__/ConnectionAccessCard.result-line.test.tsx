/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { TransportProvider } from '@/layers/shared/model';
import { ConnectionAccessCard } from '../ui/access/ConnectionAccessCard';
import type { ConnectionAccessCardProps } from '../ui/access/access-card-props';

afterEach(cleanup);

const SWITCH_LINE =
  'Ticked agents have their own access and keep it. Untick them to stop them too.';
const READ = { operationRevisionIds: ['read-v1'], level: 'read' as const };

function preview({
  grants = [],
  sharedWithEvery = false,
}: {
  grants?: ConnectorReconciliationPreview['currentGrants'];
  sharedWithEvery?: boolean;
} = {}): ConnectorReconciliationPreview {
  return {
    previewId: 'preview-1',
    connection: {
      connectionId: 'connection-1' as never,
      toolkit: 'notion',
      label: 'work',
      status: 'active',
      custody: 'external',
      reconciliationStatus: 'ready',
    },
    candidates: [
      {
        operationRevisionId: 'read-v1',
        toolkit: 'notion',
        operationSlug: 'notion.read',
        toolkitVersion: '1',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchema: {},
        supported: true,
      },
    ],
    agents: [
      { agentId: 'agent-lead', displayName: 'Marketing Lead' },
      { agentId: 'agent-scout', displayName: 'Scout' },
    ],
    currentGrants: grants,
    everyAgent: sharedWithEvery
      ? { available: true, ...READ }
      : { available: true, operationRevisionIds: [] },
    catalogComplete: true,
    createdAt: '2026-11-21T00:00:00.000Z',
    expiresAt: '2099-11-21T01:00:00.000Z',
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

const PAGE = { mode: 'page', connectionId: 'connection-1', serviceName: 'Apify' } as const;

/** The row a checkbox sits in. */
const rowOf = (name: string) => screen.getByRole('checkbox', { name }).parentElement as HTMLElement;

describe('ConnectionAccessCard — who keeps access, said before Save (DOR-4899)', () => {
  it('stopping "Every agent" says the ticked agent keeps it, and why it is ticked', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview({ sharedWithEvery: true, grants: [{ agentId: 'agent-lead', ...READ }] })
    );
    renderCard(transport, PAGE);

    const line = await screen.findByTestId('access-result-line');
    expect(line).toBeEmptyDOMElement();
    expect(screen.queryByText(SWITCH_LINE)).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Only agents you pick' }));
    expect(line).toHaveTextContent('Marketing Lead keeps Apify. Every other agent loses it.');
    expect(screen.getByText(SWITCH_LINE)).toBeInTheDocument();
    // The tag is on the pre-ticked row with its own grant, not on Scout.
    expect(within(rowOf('Marketing Lead')).getByText('Own access')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Marketing Lead' })).toHaveAccessibleDescription(
      'Own access'
    );
    expect(within(rowOf('Scout')).queryByText('Own access')).not.toBeInTheDocument();

    // Unticking it removes the tag, the switch line, and changes the result.
    await user.click(screen.getByRole('checkbox', { name: 'Marketing Lead' }));
    expect(within(rowOf('Marketing Lead')).queryByText('Own access')).not.toBeInTheDocument();
    expect(screen.queryByText(SWITCH_LINE)).not.toBeInTheDocument();
    expect(line).toHaveTextContent('No agent will be able to use Apify.');
  });

  it('a row the person ticks without its own grant gets no tag', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
    renderCard(transport, PAGE);

    await user.click(await screen.findByRole('checkbox', { name: 'Scout' }));
    expect(screen.queryByText('Own access')).not.toBeInTheDocument();
    expect(screen.getByTestId('access-result-line')).toHaveTextContent('Scout gets Apify (Read).');
  });

  it('shows no switch line when "Every agent" was not shared', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview({ grants: [{ agentId: 'agent-lead', ...READ }] })
    );
    renderCard(transport, PAGE);

    expect(await screen.findByText('Own access')).toBeInTheDocument();
    expect(screen.queryByText(SWITCH_LINE)).not.toBeInTheDocument();
  });

  it('shows no switch line when nobody is pre-ticked', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview({ sharedWithEvery: true })
    );
    renderCard(transport, PAGE);

    await user.click(await screen.findByRole('radio', { name: 'Only agents you pick' }));
    expect(screen.getByTestId('access-result-line')).toHaveTextContent(
      'No agent will be able to use Apify.'
    );
    expect(screen.queryByText(SWITCH_LINE)).not.toBeInTheDocument();
  });

  it('never shows the line on the chat card for one agent', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
    renderCard(transport, {
      mode: 'agent',
      agentId: 'agent-scout',
      toolkit: 'notion',
      connectionId: 'connection-1',
      serviceName: 'Apify',
    });

    expect(await screen.findByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(screen.queryByTestId('access-result-line')).not.toBeInTheDocument();
  });
});
