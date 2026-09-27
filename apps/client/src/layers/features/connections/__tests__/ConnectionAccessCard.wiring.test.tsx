/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { cardDecision } from '../lib/access-card-selection';
import {
  ConnectionAccessCard,
  type ConnectionAccessCardProps,
} from '../ui/access/ConnectionAccessCard';

// The UI already hides levels below what a chat agent holds, so the lower
// guard is unreachable by clicking. Spy on the decision to pin its wiring.
vi.mock('../lib/access-card-selection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/access-card-selection')>();
  return { ...actual, cardDecision: vi.fn(actual.cardDecision) };
});

afterEach(cleanup);

const PREVIEW: ConnectorReconciliationPreview = {
  previewId: 'preview-1',
  connection: {
    connectionId: 'connection-1' as never,
    toolkit: 'gmail',
    label: 'work',
    status: 'active',
    custody: 'managed',
    reconciliationStatus: 'ready',
  },
  candidates: [],
  agents: [{ agentId: 'agent-bo', displayName: 'Bo' }],
  currentGrants: [],
  everyAgent: { available: true, operationRevisionIds: [] },
  catalogComplete: true,
  createdAt: '2026-09-06T00:00:00.000Z',
  expiresAt: '2099-09-06T01:00:00.000Z',
};

async function decisionOptionsFor(props: ConnectionAccessCardProps) {
  vi.mocked(cardDecision).mockClear();
  const transport = createMockTransport();
  vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(PREVIEW);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TransportProvider transport={transport}>
        <ConnectionAccessCard {...props} />
      </TransportProvider>
    </QueryClientProvider>
  );
  await screen.findByText(/has no actions agents can use yet/);
  return vi.mocked(cardDecision).mock.calls.at(-1)?.[1];
}

describe('ConnectionAccessCard decision wiring', () => {
  it('never lets the chat answer lower an agent, while the page may', async () => {
    expect(
      await decisionOptionsFor({
        mode: 'agent',
        agentId: 'agent-bo',
        toolkit: 'gmail',
        connectionId: 'connection-1',
        serviceName: 'Gmail',
      })
    ).toMatchObject({ scope: ['agent-bo'], allowDowngrade: false });
    cleanup();
    expect(
      await decisionOptionsFor({ mode: 'page', connectionId: 'connection-1', serviceName: 'Gmail' })
    ).toMatchObject({ allowDowngrade: true });
  });
});
