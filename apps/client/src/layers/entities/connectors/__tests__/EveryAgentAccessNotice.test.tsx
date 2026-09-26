/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { ConnectorEveryAgentGrant } from '@dorkos/shared/connector-resource-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { EveryAgentAccessNotice } from '../ui/EveryAgentAccessNotice';

afterEach(() => {
  cleanup();
});

function grant(
  toolkit: string,
  label: string,
  classifications: ConnectorEveryAgentGrant['access']['classifications']
): ConnectorEveryAgentGrant {
  return {
    connectionId: `connection-${label}` as never,
    toolkit,
    label,
    lifecycle: 'connected',
    access: { operationRevisionIds: [`${label}-revision`], classifications },
  };
}

function renderNotice(
  transport: ReturnType<typeof createMockTransport>,
  agentName = 'Research Bot'
) {
  const onChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <EveryAgentAccessNotice agentName={agentName} onChange={onChange} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { ...view, onChange };
}

describe('EveryAgentAccessNotice', () => {
  it('names each app and what the new agent can do with it', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getEveryAgentConnectorGrants).mockResolvedValue({
      connections: [
        grant('gmail', 'work', ['read', 'write']),
        grant('gmail', 'home', ['read']),
        grant('notion', 'Notion', ['destructive', 'read', 'write']),
      ],
    });
    const { onChange } = renderNotice(transport);

    expect(await screen.findByTestId('every-agent-access-notice')).toHaveTextContent(
      'Research Bot will get: Gmail · work (read and write), Gmail · home (read), Notion (read, write and delete).'
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Change' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('says nothing when no app is given to every agent', async () => {
    const transport = createMockTransport();
    const { container } = renderNotice(transport);
    await waitFor(() => expect(transport.getEveryAgentConnectorGrants).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('says it could not check instead of implying the agent gets nothing', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getEveryAgentConnectorGrants).mockRejectedValue(new Error('offline'));
    renderNotice(transport, '  ');
    expect(await screen.findByTestId('every-agent-access-unknown')).toHaveTextContent(
      'Couldn’t check which apps every agent can use. This agent gets whatever you gave every agent.'
    );
  });
});
