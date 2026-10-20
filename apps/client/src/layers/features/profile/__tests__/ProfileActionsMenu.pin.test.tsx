/**
 * Pinning an agent from its profile (DOR-3092).
 *
 * The sidebar draws an agent only once you have a direct message with it or
 * have pinned it, so the profile — reached from the Directory — has to offer
 * the pin. It writes `ui.sidebar.pinned` exactly as the sidebar row's menu
 * does.
 *
 * @vitest-environment jsdom
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { SIDEBAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';

// The confirmations and the blocked read are their own suite's subject.
vi.mock('../ui/ProfileAgentActions', () => ({
  ProfileAgentActions: () => null,
  useIsAgentBlocked: () => false,
}));
vi.mock('../model/use-profile-agent', () => ({
  useProfileAgent: () => ({ agent: { name: 'warden' } }),
}));
vi.mock('@/layers/entities/mesh', () => ({
  useAgentPause: () => null,
  useResumeAgent: () => ({ mutate: vi.fn() }),
}));

import { ProfileActionsMenu } from '../ui/ProfileActionsMenu';

const MANAGED: TeamMember = MOCK_TEAM_ROSTER.find((member) => member.id === 'agent-warden')!;
const PATH = MANAGED.agent!.projectPath;

/** Mount the kebab over a config whose sidebar pins are `pinned`. */
function renderMenu(pinned: Array<{ kind: 'agent'; path: string }>) {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      ui: { sidebar: { ...SIDEBAR_PREFS_DEFAULTS, pinned } },
    }),
    updateConfig: vi.fn().mockResolvedValue({}),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  render(<ProfileActionsMenu member={MANAGED} relationship="managed" />, { wrapper: Wrapper });
  return transport;
}

/** Open the kebab and wait for the config read the pin label depends on. */
async function openMenu(transport: ReturnType<typeof createMockTransport>) {
  await waitFor(() => expect(transport.getConfig).toHaveBeenCalled());
  await userEvent.click(screen.getByRole('button', { name: `Actions for ${MANAGED.displayName}` }));
}

afterEach(() => cleanup());

describe('ProfileActionsMenu — pinning an agent', () => {
  it('pins an agent to the sidebar', async () => {
    const transport = renderMenu([]);
    await openMenu(transport);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Pin to sidebar' }));
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        ui: { sidebar: expect.objectContaining({ pinned: [{ kind: 'agent', path: PATH }] }) },
      })
    );
  });

  it('unpins one that is already pinned', async () => {
    const transport = renderMenu([{ kind: 'agent', path: PATH }]);
    await openMenu(transport);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Unpin from sidebar' }));
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        ui: { sidebar: expect.objectContaining({ pinned: [] }) },
      })
    );
  });
});
