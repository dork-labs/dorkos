// @vitest-environment jsdom
/**
 * The status line's agent chip opens the profile drawer (DOR-957).
 *
 * The chip knows the agent by its DIRECTORY; the drawer knows it by the id the
 * mesh registered. So the fixture keeps those visibly different and the
 * assertion is on the id that reached the URL — a chip that passed its path
 * along would open a drawer that finds nobody, and "something opened" would not
 * have caught it.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { useAgentHubStore } from '@/layers/features/agent-hub';
import {
  buildProfileDeepLinkHarness,
  type ProfileDeepLinkHarness,
} from '@/test-helpers/profile-deep-link';
import { AgentIdentityChip } from '../ui/status/AgentIdentityChip';

const AGENT_PATH = '/projects/alpha';
const AGENT_MEMBER_ID = '01JALPHAREGISTRYULID';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

let harness: ProfileDeepLinkHarness;

beforeEach(() => {
  harness = buildProfileDeepLinkHarness();
  useAgentHubStore.setState({ agentPath: null });
  useAppStore.setState({ rightPanelOpen: false });
});

afterEach(cleanup);

/** The fleet as `GET /api/mesh/agent-paths` returns it — or an empty one. */
function renderChip(fleet: { id: string; name: string; projectPath: string }[]) {
  const transport = createMockTransport({
    listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: fleet }),
  } as Partial<Transport>);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  render(
    <AgentIdentityChip
      agentName="Alpha"
      agentColor="#aaaaaa"
      agentEmoji="🤖"
      agentPath={AGENT_PATH}
    />,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>
            <harness.Wrapper>{children}</harness.Wrapper>
          </TransportProvider>
        </QueryClientProvider>
      ),
    }
  );
  /** Settle every in-flight read, so a click below can never race the fleet. */
  return async () => {
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  };
}

const KNOWN_FLEET = [{ id: AGENT_MEMBER_ID, name: 'alpha', projectPath: AGENT_PATH }];

describe('AgentIdentityChip — click opens the profile', () => {
  it('opens it under the id the ROSTER holds, not the path the chip was given', async () => {
    const user = userEvent.setup();
    const fleetSettled = renderChip(KNOWN_FLEET);
    await fleetSettled();

    await user.click(await screen.findByRole('button', { name: /Alpha/ }));

    expect(harness.openProfileId()).toBe(AGENT_MEMBER_ID);
    expect(harness.openProfileId()).not.toBe(AGENT_PATH);
    // And it did NOT take the degraded path — the Hub was never opened.
    expect(useAgentHubStore.getState().agentPath).toBeNull();
  });

  it('falls back to the Agent Hub when the mesh cannot name this agent', async () => {
    // Never a dead click: with no roster id there is no drawer to open, so the
    // chip keeps the behaviour it had before this change.
    const user = userEvent.setup();
    const fleetSettled = renderChip([]);
    await fleetSettled();

    await user.click(await screen.findByRole('button', { name: /Alpha/ }));

    expect(harness.openProfileId()).toBeNull();
    expect(useAgentHubStore.getState().agentPath).toBe(AGENT_PATH);
  });
});
