/**
 * @vitest-environment jsdom
 */
/**
 * What an agent can do (DOR-4115): one row per permission area with its live
 * level, Files & commands first as on the Permissions page, the areas no level
 * governs last under "Set elsewhere", and a level changed on the Permissions
 * page showing here without a reload.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import { GATED_AREAS, type AgentPermissionsResponse } from '@dorkos/shared/permissions';
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

function area(
  id: AreaEntry['id'],
  label: string,
  state: AreaEntry['resolved']['state']
): AreaEntry {
  return {
    id,
    label,
    description: `${label} words`,
    floor: false,
    kind: 'state',
    actions: [],
    resolved: { state, source: 'preset', layer: 'default' },
    inherited: { state, source: 'preset', layer: 'default' },
    changedOutsideAt: null,
  };
}

/** A made-up agent with eight areas, so "Show all" has something to hide. */
function atlas(rooms: AreaEntry['resolved']['state'] = 'allowed'): AgentPermissionsResponse {
  return {
    agentId: 'atlas',
    agentName: 'Atlas',
    overrides: {},
    filesAndCommands: {
      stop: 'act',
      source: 'default',
      inherited: { stop: 'act', source: 'default' },
    },
    areas: [
      area('rooms', 'Rooms', rooms),
      area('tasks', 'Tasks & schedules', 'ask'),
      area('agents', 'Other agents', 'blocked'),
      area('messages', 'Messages', 'allowed'),
      area('connections', 'Chat connections', 'ask'),
      area('packages', 'Tools & packages', 'ask'),
      area('extensions', 'Extension tools', 'allowed'),
      area('settings', 'DorkOS settings', 'blocked'),
    ],
  };
}

const levelOf = (id: string) => screen.getByTestId(`can-do-level-${id}`).textContent;

describe('AgentCanDo', () => {
  it('lists Files & commands first, then each area with its level, in the page’s order', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getAgentPermissions).mockResolvedValue(atlas());
    render(<AgentCanDo agentId="atlas" agentName="Atlas" />, { wrapper });

    await userEvent.click(await screen.findByRole('button', { name: 'Show all 13 areas' }));

    const rows = screen
      .getAllByTestId(/^can-do-row-/)
      .map((row) => row.getAttribute('data-testid')!.replace('can-do-row-', ''));
    expect(rows).toEqual([
      'files',
      'rooms',
      'tasks',
      'agents',
      'messages',
      'connections',
      'packages',
      'extensions',
      'settings',
      ...GATED_AREAS.map((gated) => gated.id),
    ]);
    expect(levelOf('files')).toBe('Act');
    expect(levelOf('rooms')).toBe('Allowed');
    expect(levelOf('tasks')).toBe('Ask');
    expect(levelOf('agents')).toBe('Blocked');
  });

  it('keeps the areas no level governs last, under Set elsewhere, each chip saying what decides it', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getAgentPermissions).mockResolvedValue(atlas());
    render(<AgentCanDo agentId="atlas" agentName="Atlas" />, { wrapper });

    // Collapsed: six rows, none of them gated.
    await screen.findByText('What Atlas can do');
    expect(screen.getAllByTestId(/^can-do-row-/)).toHaveLength(6);
    expect(screen.queryByText('Set elsewhere')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show all 13 areas' }));
    const elsewhere = screen.getByTestId('can-do-set-elsewhere');
    expect(screen.getByText('Set elsewhere')).toBeInTheDocument();
    for (const gated of GATED_AREAS) {
      expect(within(elsewhere).getByText(gated.description)).toBeInTheDocument();
      expect(levelOf(gated.id)).toBe(gated.gate);
      expect(levelOf(gated.id)).not.toMatch(/gated/i);
    }

    await userEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.getAllByTestId(/^can-do-row-/)).toHaveLength(6);
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
});
