/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorAgentRequestItem } from '@dorkos/shared/connector-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ApprovalSubject } from '../ui/ApprovalSubject';

afterEach(cleanup);

function renderSubject(subject: Parameters<typeof ApprovalSubject>[0]['subject']) {
  const transport = createMockTransport({
    getConnectorAgentRequest: vi.fn().mockResolvedValue({
      requestId: 'request-01KX',
      agent: { id: 'agent-newbie', displayName: 'Flow Snapshot' },
    } as ConnectorAgentRequestItem),
    // Two agents with the same name: only the face tells them apart.
    listMeshAgents: vi.fn().mockResolvedValue({
      agents: [
        { id: 'agent-twin', name: 'twin', displayName: 'Flow Snapshot', icon: '🦊' },
        { id: 'agent-newbie', name: 'newbie', displayName: 'Flow Snapshot', icon: '📸' },
      ],
    }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <ApprovalSubject subject={subject} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('ApprovalSubject', () => {
  // Security S2 on #3575: the face is what tells two same-named agents apart, so it must be the
  // asking agent's own.
  it('draws the asking agent’s own avatar, never a same-named agent’s', async () => {
    renderSubject({ kind: 'agent_request', label: 'Flow Snapshot · Linear', id: 'request-01KX' });
    await waitFor(() =>
      expect(document.querySelector('[data-slot="approval-subject-agent"]')).not.toBeNull()
    );
    const avatar = document.querySelector('[data-slot="approval-subject-agent"]')!;
    expect(avatar).toHaveTextContent('📸');
    expect(avatar).not.toHaveTextContent('🦊');
  });

  it('names another agent’s request by who asked and the app, with their avatar; the id waits behind ⓘ', async () => {
    const user = userEvent.setup();
    renderSubject({ kind: 'agent_request', label: 'Flow Snapshot · Linear', id: 'request-01KX' });

    expect(screen.getByText('Read request')).toBeInTheDocument();
    expect(screen.getByText('Flow Snapshot · Linear')).toBeInTheDocument();
    expect(screen.queryByText('request-01KX')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector('[data-slot="approval-subject-agent"]')).not.toBeNull()
    );

    const details = screen.getByRole('button', { name: 'Details' });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    await user.click(details);
    expect(details).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('request-01KX')).toBeInTheDocument();
  });

  it('keeps the id in view for every other kind, and reads no request for it', () => {
    const transport = renderSubject({ kind: 'agent', label: 'DorkBot', id: '01KXQ3P7AD' });
    expect(screen.getByText('01KXQ3P7AD')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Details' })).not.toBeInTheDocument();
    expect(transport.getConnectorAgentRequest).not.toHaveBeenCalled();
  });
});
