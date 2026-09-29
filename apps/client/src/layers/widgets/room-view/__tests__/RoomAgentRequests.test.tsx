/**
 * An agent's request for an app, shown in the room whose turn raised it and
 * in no other (DOR-2415).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorAgentRequestItem } from '@dorkos/shared/connector-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { RoomAgentRequests } from '../ui/RoomAgentRequests';

afterEach(cleanup);

function request(roomId: string | undefined, requestId: string): ConnectorAgentRequestItem {
  return {
    requestId,
    serviceSlug: 'gmail',
    reason: 'Summarise today’s inbox',
    access: 'read',
    requestedEvents: [],
    note: 'The person said no to Gmail.',
    createdAt: '2026-09-26T10:00:00.000Z',
    expiresAt: '2099-09-26T12:00:00.000Z',
    status: 'denied',
    sessionId: `session-${requestId}`,
    agent: { id: 'agent-bo', displayName: 'Bo' },
    ...(roomId ? { roomId } : {}),
  } as ConnectorAgentRequestItem;
}

function renderRoom(roomId: string, requests: ConnectorAgentRequestItem[] | Error) {
  const transport = createMockTransport();
  if (requests instanceof Error) {
    vi.mocked(transport.getConnectorAgentRequests).mockRejectedValue(requests);
  } else {
    vi.mocked(transport.getConnectorAgentRequests).mockResolvedValue(requests);
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return { transport, ...render(<RoomAgentRequests roomId={roomId} />, { wrapper: Wrapper }) };
}

describe('RoomAgentRequests', () => {
  it("draws only this room's open requests", async () => {
    const { transport } = renderRoom('room-lunar', [
      request('room-lunar', 'mine'),
      request('room-other', 'theirs'),
      request(undefined, 'direct-chat'),
    ]);
    expect(await screen.findAllByTestId('agent-request-receipt')).toHaveLength(1);
    expect(transport.getConnectorAgentRequests).toHaveBeenCalledWith('pending');
  });

  it('draws nothing for someone who cannot read requests', async () => {
    const { container, transport } = renderRoom('room-lunar', new Error('forbidden'));
    await vi.waitFor(() => expect(transport.getConnectorAgentRequests).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
