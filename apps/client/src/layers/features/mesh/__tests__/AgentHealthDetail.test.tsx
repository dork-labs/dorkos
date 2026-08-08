// @vitest-environment jsdom
/**
 * The topology detail panel routes to the ONE profile drawer (spec
 * `identity-consistency` §W2.5) rather than growing a second profile of its own.
 *
 * The panel is about mesh health; who the agent IS lives in the drawer. The
 * assertion that matters is the id: this panel is selected by the mesh registry
 * id, which is the same id the roster files the agent under, so it hands that
 * straight over.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  buildProfileDeepLinkHarness,
  type ProfileDeepLinkHarness,
} from '@/test-helpers/profile-deep-link';
import { AgentHealthDetail } from '../ui/AgentHealthDetail';

const AGENT_ID = '01JALPHAREGISTRYULID';

let harness: ProfileDeepLinkHarness;

beforeEach(() => {
  harness = buildProfileDeepLinkHarness();
});

afterEach(cleanup);

function renderPanel() {
  const transport = createMockTransport({
    getMeshAgentHealth: vi.fn().mockResolvedValue({
      id: AGENT_ID,
      name: 'Alpha',
      status: 'active',
      runtime: 'claude-code',
      lastSeenAt: '2026-08-06T10:00:00.000Z',
      registeredAt: '2026-07-01T10:00:00.000Z',
      capabilities: [],
    }),
  } as Partial<Transport>);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  render(<AgentHealthDetail agentId={AGENT_ID} onClose={vi.fn()} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <harness.Wrapper>{children}</harness.Wrapper>
        </TransportProvider>
      </QueryClientProvider>
    ),
  });
}

describe('AgentHealthDetail', () => {
  it('opens the profile drawer for the agent it is showing', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'View profile' }));

    expect(harness.openProfileId()).toBe(AGENT_ID);
  });
});
