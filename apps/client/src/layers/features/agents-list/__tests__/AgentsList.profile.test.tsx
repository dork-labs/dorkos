// @vitest-environment jsdom
/**
 * The Team table's View profile opens the same profile the cards do (DOR-1255).
 *
 * A separate file from `AgentsList.test.tsx` for one reason: that file mocks
 * `@tanstack/react-router` wholesale, and the whole claim here is what a REAL
 * router ends up with in its URL. A spy on a mocked hook would say yes to any
 * string, including one from the wrong id space — and the table knows agents by
 * their DIRECTORY while the profile is addressed by the id the mesh registered,
 * which is exactly the mix-up worth catching (spec `profile-unification` §1.6:
 * docked on `/session`, the sheet everywhere else, one address).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TopologyAgent } from '@dorkos/shared/mesh-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { useProfileStore } from '@/layers/features/profile';
import {
  buildProfileDeepLinkHarness,
  type ProfileDeepLinkHarness,
} from '@/test-helpers/profile-deep-link';
import { AgentsList } from '../ui/AgentsList';

const AGENT_PATH = '/projects/alpha';
const AGENT_MEMBER_ID = '01JALPHAREGISTRYULID';

const ALPHA: TopologyAgent = {
  id: 'manifest-alpha',
  name: 'Alpha',
  description: '',
  runtime: 'claude-code',
  capabilities: [],
  behavior: { responseMode: 'always' },
  registeredAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  registeredBy: 'user',
  personaEnabled: true,
  enabledToolGroups: {},
  mcpServers: [],
  projectPath: AGENT_PATH,
  healthStatus: 'active',
  relayAdapters: [],
  relaySubject: null,
  taskCount: 0,
  lastSeenAt: null,
  lastSeenEvent: null,
};

/** The fleet as `GET /api/mesh/agent-paths` returns it, when it knows this agent. */
const KNOWN_FLEET = [{ id: AGENT_MEMBER_ID, name: 'alpha', projectPath: AGENT_PATH }];

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
  useProfileStore.setState({ dockedEntries: {} });
  useAppStore.setState({
    rightPanelOpen: false,
    explicitAgentPath: null,
    activeRightPanelTab: null,
  });
});

afterEach(cleanup);

/** Render the fleet table inside a real router, over the fleet it is handed. */
function renderTable(fleet: { id: string; name: string; projectPath: string }[]) {
  const transport = createMockTransport({
    listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: fleet }),
  } as Partial<Transport>);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  render(<AgentsList agents={[ALPHA]} isLoading={false} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <TooltipProvider>
            <harness.Wrapper>{children}</harness.Wrapper>
          </TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    ),
  });

  /** Settle every in-flight read, so a click below can never race the fleet. */
  return async () => {
    await harness.ready();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  };
}

const viewProfile = () => screen.getByRole('button', { name: 'Open Alpha’s profile' });

describe('the Team table’s row action', () => {
  it('opens the sheet under the id the ROSTER holds, not the path the row carries', async () => {
    const user = userEvent.setup();
    const settled = renderTable(KNOWN_FLEET);
    await settled();

    await user.click(viewProfile());

    expect(harness.openProfileId()).toBe(AGENT_MEMBER_ID);
    expect(harness.openProfileId()).not.toBe(AGENT_PATH);
    // And it did NOT dock: the docked profile belongs to `/session`, and the
    // cards on this very page open the sheet.
    expect(useAppStore.getState().explicitAgentPath).toBeNull();
    expect(useAppStore.getState().rightPanelOpen).toBe(false);
  });

  it('falls back to the docked panel when the mesh cannot name this agent', async () => {
    // Never a dead click: with no roster id there is no sheet to address, but
    // the panel is bound to a directory and the row always has one.
    const user = userEvent.setup();
    const settled = renderTable([]);
    await settled();

    await user.click(viewProfile());

    expect(harness.openProfileId()).toBeNull();
    expect(useAppStore.getState().explicitAgentPath).toBe(AGENT_PATH);
    expect(useAppStore.getState().activeRightPanelTab).toBe('profile');
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
  });
});
