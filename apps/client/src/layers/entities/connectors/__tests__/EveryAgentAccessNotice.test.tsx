/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <EveryAgentAccessNotice agentName={agentName} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return view;
}

describe('EveryAgentAccessNotice', () => {
  it('names each app, what the new agent can do with it, and where to change it', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getEveryAgentConnectorGrants).mockResolvedValue({
      connections: [
        grant('gmail', 'work', ['read', 'write']),
        { ...grant('gmail', 'home', ['read']), lifecycle: 'paused' },
        grant('notion', 'Notion', ['destructive', 'read', 'write']),
      ],
    });
    renderNotice(transport);

    expect(await screen.findByTestId('every-agent-access-notice')).toHaveTextContent(
      'Research Bot will get: Gmail · work (read and write), Gmail · home (read, paused), Notion (read, write and delete). You can change this in Connections.'
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says it is still checking while the answer loads', () => {
    const transport = createMockTransport();
    vi.mocked(transport.getEveryAgentConnectorGrants).mockReturnValue(new Promise(() => {}));
    renderNotice(transport);
    expect(screen.getByTestId('every-agent-access-checking')).toHaveTextContent(
      'Checking which apps every agent can use…'
    );
  });

  it('says nothing when no app is given to every agent', async () => {
    const transport = createMockTransport();
    const { container } = renderNotice(transport);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(transport.getEveryAgentConnectorGrants).toHaveBeenCalled();
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
