/**
 * @vitest-environment jsdom
 *
 * Profile › Reports to (spec `heartbeats` §4.3): the picker lists you first,
 * then the other agents, marks the default, saves through the agent's own edit
 * route, and shows a refused loop under the list instead of a toast.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { ReportsToPopover } from '../ui/popovers/ReportsToPopover';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }));
vi.mock('sonner', () => ({
  toast: Object.assign(toasts.message, { success: toasts.success, error: toasts.error }),
}));

const SELF = {
  id: 'p1',
  kind: 'human',
  displayName: 'Dorian',
  handle: 'dorian',
  isSelf: true,
  ownerId: null,
  origin: 'local',
  person: { role: null, lastSeenAt: null, accountId: 'acct-1' },
} as TeamMember;

/** An agent roster row. */
function agentRow(id: string, name: string): TeamMember {
  return {
    id,
    kind: 'agent',
    displayName: name,
    handle: null,
    isSelf: false,
    ownerId: 'p1',
    origin: 'local',
    agent: { manifestId: id, projectPath: `/agents/${id}`, runtime: 'claude-code' },
  } as unknown as TeamMember;
}

const ATLAS = agentRow('A', 'Atlas');
const JUNO = agentRow('J', 'Juno');

/** Atlas's manifest, with nothing set. */
const ATLAS_MANIFEST = {
  id: 'A',
  name: 'atlas',
  runtime: 'claude-code',
  description: '',
  capabilities: [],
  behavior: { responseMode: 'always' },
} as unknown as AgentManifest;

function renderPopover(over: Record<string, unknown> = {}) {
  const config = createQueryClientConfig();
  const queryClient = new QueryClient({
    ...config,
    defaultOptions: {
      ...config.defaultOptions,
      queries: { ...config.defaultOptions?.queries, retry: false, gcTime: 0 },
    },
  });
  const transport = createMockTransport({
    getAgentByPath: vi.fn().mockResolvedValue(ATLAS_MANIFEST),
    updateAgentByPath: vi.fn().mockResolvedValue({ ...ATLAS_MANIFEST, reportsTo: 'J' }),
    getTeamRoster: vi.fn().mockResolvedValue({ members: [SELF, ATLAS, JUNO] }),
    ...over,
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  render(
    <Wrapper>
      <ReportsToPopover member={ATLAS} onClose={() => {}} />
    </Wrapper>
  );
  return transport;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ReportsToPopover', () => {
  it('lists you first as the default, then the other agents, never itself', async () => {
    renderPopover();
    const options = await screen.findAllByRole('radio');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAccessibleName('You (default)');
    expect(options[1]).toHaveAccessibleName('Juno');
    expect(options[0]).toHaveAttribute('aria-checked', 'true');
  });

  it('saves the picked agent through the agent edit route', async () => {
    const transport = renderPopover();
    await userEvent.click(await screen.findByRole('radio', { name: 'Juno' }));
    await waitFor(() =>
      expect(transport.updateAgentByPath).toHaveBeenCalledWith('/agents/A', { reportsTo: 'J' })
    );
  });

  it('saves "You" as your account id', async () => {
    const transport = renderPopover();
    await userEvent.click(await screen.findByRole('radio', { name: /You/ }));
    await waitFor(() =>
      expect(transport.updateAgentByPath).toHaveBeenCalledWith('/agents/A', {
        reportsTo: 'acct-1',
      })
    );
  });

  it('shows a refused loop under the list, and not as a toast', async () => {
    const refusal = Object.assign(
      new Error('That would make a loop: an agent can’t report to someone who reports to it.'),
      { code: 'REPORTS_TO_CYCLE', status: 400 }
    );
    renderPopover({ updateAgentByPath: vi.fn().mockRejectedValue(refusal) });
    await userEvent.click(await screen.findByRole('radio', { name: 'Juno' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That would make a loop');
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('offers the default back once a manager is set', async () => {
    const transport = renderPopover({
      getAgentByPath: vi.fn().mockResolvedValue({ ...ATLAS_MANIFEST, reportsTo: 'J' }),
    });
    const juno = await screen.findByRole('radio', { name: 'Juno' });
    expect(juno).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Use the default' }));
    await waitFor(() =>
      expect(transport.updateAgentByPath).toHaveBeenCalledWith('/agents/A', { reportsTo: null })
    );
  });
});
