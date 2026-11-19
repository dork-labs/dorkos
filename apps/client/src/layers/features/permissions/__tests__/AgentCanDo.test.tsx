/**
 * @vitest-environment jsdom
 */
/**
 * What an agent can do (DOR-4115): one row per permission area, in the
 * registry's order, with the area's own description and this agent's live
 * level. Eight rows show, then the rest behind "Show all". Read only: a level
 * changed on the Permissions page shows here without a reload.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import {
  PERMISSION_AREAS,
  type AgentPermissionsResponse,
  type PermissionState,
} from '@dorkos/shared/permissions';
import { TransportProvider } from '@/layers/shared/model';

import { AgentCanDo } from '../ui/AgentCanDo';
import { PermissionList } from '../ui/PermissionList';

afterEach(() => cleanup());

function wrap(transport = createMockTransport()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { transport, wrapper };
}

type AreaEntry = AgentPermissionsResponse['areas'][number];

/** The levels Atlas has, per area; anything unnamed is Ask. */
const LEVELS: Partial<Record<string, PermissionState>> = {
  rooms: 'allowed',
  tasks: 'ask',
  agents: 'blocked',
  messages: 'allowed',
};

/** A made-up agent with every state area, as the server answers it. */
function atlas(rooms: PermissionState = 'allowed'): AgentPermissionsResponse {
  const levels: Partial<Record<string, PermissionState>> = { ...LEVELS, rooms };
  return {
    agentId: 'atlas',
    agentName: 'Atlas',
    overrides: {},
    filesAndCommands: {
      stop: 'act',
      source: 'default',
      inherited: { stop: 'act', source: 'default' },
    },
    areas: PERMISSION_AREAS.filter((area) => area.kind === 'state').map((area): AreaEntry => {
      const state = levels[area.id] ?? 'ask';
      return {
        id: area.id as AreaEntry['id'],
        label: area.label,
        description: area.description,
        floor: area.floor,
        kind: 'state',
        actions: [],
        resolved: { state, source: 'preset', layer: 'default' },
        inherited: { state, source: 'preset', layer: 'default' },
        changedOutsideAt: null,
      };
    }),
  };
}

const SHOW_ALL = `Show all ${PERMISSION_AREAS.length} areas`;
const rowIds = () =>
  within(screen.getByRole('list', { name: 'What Atlas can do' }))
    .getAllByRole('listitem')
    .map((row) => row.getAttribute('data-area'));
const levelOf = (id: string) =>
  screen.getByTestId(`can-do-row-${id}`).querySelector('[data-slot="badge"]')?.textContent;

describe('AgentCanDo', () => {
  it('lists every area in the registry’s order, with its own words and live level', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getAgentPermissions).mockResolvedValue(atlas());
    render(<AgentCanDo agentId="atlas" agentName="Atlas" />, { wrapper });

    await userEvent.click(await screen.findByRole('button', { name: SHOW_ALL }));

    expect(rowIds()).toEqual(PERMISSION_AREAS.map((area) => area.id));
    for (const area of PERMISSION_AREAS) {
      const row = screen.getByTestId(`can-do-row-${area.id}`);
      expect(within(row).getByText(area.label)).toBeInTheDocument();
      expect(within(row).getByText(area.description)).toBeInTheDocument();
    }
    expect(levelOf('rooms')).toBe('Allowed');
    expect(levelOf('tasks')).toBe('Ask');
    expect(levelOf('agents')).toBe('Blocked');
    // Files & commands takes a stop, named the way the dial names it.
    expect(levelOf('files')).toBe('Act');
  });

  it('shows eight rows, then the rest behind a button that says it is collapsed', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getAgentPermissions).mockResolvedValue(atlas());
    render(<AgentCanDo agentId="atlas" agentName="Atlas" />, { wrapper });

    const more = await screen.findByRole('button', { name: SHOW_ALL });
    expect(rowIds()).toEqual(PERMISSION_AREAS.slice(0, 8).map((area) => area.id));
    expect(more).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(more);
    expect(rowIds()).toHaveLength(PERMISSION_AREAS.length);
    const fewer = screen.getByRole('button', { name: 'Show fewer' });
    expect(fewer).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(fewer);
    expect(rowIds()).toHaveLength(8);
  });

  it('says Not set when Files & commands has no stop of its own', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getAgentPermissions).mockResolvedValue({
      ...atlas(),
      filesAndCommands: {
        stop: null,
        source: 'runtime-own',
        inherited: { stop: null, source: 'runtime-own' },
      },
    });
    render(<AgentCanDo agentId="atlas" agentName="Atlas" />, { wrapper });

    await userEvent.click(await screen.findByRole('button', { name: SHOW_ALL }));
    expect(levelOf('files')).toBe('Not set');
  });

  it('never changes a level: it has no switch, and writes nothing', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getAgentPermissions).mockResolvedValue(atlas());
    render(<AgentCanDo agentId="atlas" agentName="Atlas" />, { wrapper });

    await userEvent.click(await screen.findByRole('button', { name: SHOW_ALL }));
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(transport.patchAgentPermissions).not.toHaveBeenCalled();
  });

  it('shows a level changed on the Permissions page, without a reload', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getAgentPermissions).mockResolvedValue(atlas('allowed'));
    vi.mocked(transport.patchAgentPermissions).mockImplementation(async () => {
      // The server now answers with the new level.
      vi.mocked(transport.getAgentPermissions).mockResolvedValue(atlas('blocked'));
      return { changes: [], permissions: atlas('blocked') };
    });
    render(
      <>
        <AgentCanDo agentId="atlas" agentName="Atlas" />
        <PermissionList scope={{ kind: 'agent', agentId: 'atlas' }} />
      </>,
      { wrapper }
    );

    await waitFor(() => expect(levelOf('rooms')).toBe('Allowed'));
    const roomsRow = await screen.findByTestId('permission-row-rooms');
    await userEvent.click(within(roomsRow).getByRole('radio', { name: 'Blocked' }));

    await waitFor(() => expect(levelOf('rooms')).toBe('Blocked'));
  });

  it('opens Permissions from its link', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getAgentPermissions).mockResolvedValue(atlas());
    const onOpenPermissions = vi.fn();
    render(<AgentCanDo agentId="atlas" agentName="Atlas" onOpenPermissions={onOpenPermissions} />, {
      wrapper,
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Change in Permissions' }));
    expect(onOpenPermissions).toHaveBeenCalledTimes(1);
  });

  it('says calmly when the levels could not be read, and asks again on Retry', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getAgentPermissions).mockRejectedValueOnce(new Error('offline'));
    render(<AgentCanDo agentId="atlas" agentName="Atlas" />, { wrapper });

    expect(await screen.findByText('Couldn’t load what Atlas can do')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'What Atlas can do' })).not.toBeInTheDocument();

    vi.mocked(transport.getAgentPermissions).mockResolvedValue(atlas());
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'What Atlas can do' })).toBeInTheDocument();
  });

  it('waits quietly while loading, and asks for nothing without an agent', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getAgentPermissions).mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<AgentCanDo agentId="atlas" agentName="Atlas" />, { wrapper });
    expect(screen.getByTestId('agent-can-do')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('list', { name: 'What Atlas can do' })).not.toBeInTheDocument();
    unmount();

    vi.mocked(transport.getAgentPermissions).mockClear();
    render(<AgentCanDo agentId={undefined} agentName="Atlas" />, { wrapper });
    expect(screen.getByText('Pick an agent to see what it can do.')).toBeInTheDocument();
    expect(transport.getAgentPermissions).not.toHaveBeenCalled();
  });
});
