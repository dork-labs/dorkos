/**
 * @vitest-environment jsdom
 */
/**
 * The permission surfaces: a row says where its state came from and resets to
 * the default, the apply dialog never moves an agent nobody named, and the
 * exceptions chip lists who differs and resets each one.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import type {
  AgentPermissionsResponse,
  PermissionException,
  PermissionsResponse,
} from '@dorkos/shared/permissions';
import { TransportProvider } from '@/layers/shared/model';

import { PermissionRow } from '../ui/PermissionRow';
import { ApplyToOverridesDialog } from '../ui/ApplyToOverridesDialog';
import { ExceptionsChip } from '../ui/ExceptionsChip';
import { PermissionList } from '../ui/PermissionList';
import { PermissionHistory } from '../ui/PermissionHistory';

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

const AUDITOR: PermissionException = {
  agentId: 'a1',
  agentName: 'security-auditor',
  area: 'rooms',
  state: 'blocked',
};
const TESTER: PermissionException = {
  agentId: 'a2',
  agentName: 'test-bot',
  area: 'rooms',
  state: 'ask',
};

/** The two agents as the apply dialog lists them. */
const DIFF_AUDITOR = { agentId: 'a1', agentName: 'security-auditor', detail: 'Blocked' };
const DIFF_TESTER = { agentId: 'a2', agentName: 'test-bot', detail: 'Ask' };

describe('PermissionRow', () => {
  it('shows where the state came from, and a Reset only when the agent has its own', async () => {
    const onReset = vi.fn();
    const { rerender } = render(
      <PermissionRow
        areaId="rooms"
        label="Rooms"
        description="Make rooms"
        floor={false}
        value="allowed"
        sourceText="Same as everyone (Allowed)"
        onChange={() => {}}
        onReset={onReset}
      />
    );
    expect(screen.getByText('Same as everyone (Allowed)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reset to default/i })).not.toBeInTheDocument();

    rerender(
      <PermissionRow
        areaId="rooms"
        label="Rooms"
        description="Make rooms"
        floor={false}
        value="blocked"
        sourceText="Everyone else: Allowed"
        changed
        onChange={() => {}}
        onReset={onReset}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /reset to default/i }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('img', { name: /set differently/i })).toBeInTheDocument();
  });

  it('offers two states and a lock on a floor area', () => {
    render(
      <PermissionRow
        areaId="reach"
        label="Reach & secrets"
        description="Open this computer"
        floor
        value="ask"
        sourceText="From Full power"
        onChange={() => {}}
      />
    );
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Blocked', 'Ask']);
    expect(screen.getByLabelText('Never Allowed')).toBeInTheDocument();
  });
});

describe('ApplyToOverridesDialog', () => {
  it('pre-checks nothing, counts who follows the default, and sends exactly the chosen ids', async () => {
    const onUpdate = vi.fn();
    render(
      <ApplyToOverridesDialog
        open
        onCancel={() => {}}
        subject="Rooms"
        next="allowed"
        agents={[DIFF_AUDITOR, DIFF_TESTER]}
        affectedCount={33}
        onKeep={() => {}}
        onUpdate={onUpdate}
      />
    );
    expect(screen.getByText('Rooms will be set to Allowed for everyone.')).toBeInTheDocument();
    expect(screen.getByText('This affects 33 agents now.')).toBeInTheDocument();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box).not.toBeChecked();
    // Nothing chosen, nothing to update.
    expect(screen.getByRole('button', { name: 'Update selected' })).toBeDisabled();

    await userEvent.click(screen.getByLabelText('test-bot: Ask'));
    await userEvent.click(screen.getByRole('button', { name: 'Update selected' }));
    expect(onUpdate).toHaveBeenCalledWith(['a2']);
  });

  it('never pre-selects when a floor area goes up either', () => {
    render(
      <ApplyToOverridesDialog
        open
        onCancel={() => {}}
        subject="Reach & secrets"
        next="ask"
        agents={[DIFF_AUDITOR]}
        affectedCount={1}
        onKeep={() => {}}
        onUpdate={() => {}}
      />
    );
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('keeps their settings when asked', async () => {
    const onKeep = vi.fn();
    render(
      <ApplyToOverridesDialog
        open
        onCancel={() => {}}
        subject="Rooms"
        next="allowed"
        agents={[DIFF_AUDITOR]}
        affectedCount={2}
        onKeep={onKeep}
        onUpdate={() => {}}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Keep their settings' }));
    expect(onKeep).toHaveBeenCalledTimes(1);
  });
});

describe('ExceptionsChip', () => {
  it('counts the agents that differ and resets one to the default', async () => {
    const { transport, wrapper } = wrap();
    render(<ExceptionsChip area="rooms" areaLabel="Rooms" agents={[AUDITOR, TESTER]} />, {
      wrapper,
    });

    await userEvent.click(screen.getByRole('button', { name: /2 agents differ/i }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Reset security-auditor to the default' })
    );

    await waitFor(() =>
      expect(transport.patchAgentPermissions).toHaveBeenCalledWith('a1', {
        areas: { rooms: null },
        surface: 'settings',
      })
    );
  });

  it('renders nothing when no agent differs', () => {
    const { wrapper } = wrap();
    const { container } = render(<ExceptionsChip area="rooms" areaLabel="Rooms" agents={[]} />, {
      wrapper,
    });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('PermissionList (default scope)', () => {
  const OVERVIEW: PermissionsResponse = {
    preset: 'full',
    defaults: { areas: {}, actions: {} },
    changeCount: 0,
    filesAndCommands: { stop: 'autonomy', presetStop: 'autonomy', runtimes: [], exceptions: [] },
    areas: [
      {
        id: 'rooms',
        label: 'Rooms',
        description: 'Make rooms',
        floor: false,
        kind: 'state',
        actions: [
          {
            id: 'rooms.create',
            title: 'Open a room',
            tier: 'act',
            resolved: { area: 'rooms', state: 'allowed', source: 'preset', layer: 'default' },
          },
        ],
        resolved: { state: 'allowed', source: 'preset', layer: 'default' },
      },
      {
        id: 'tasks',
        label: 'Tasks & schedules',
        description: 'Tasks',
        floor: false,
        kind: 'state',
        actions: [],
        resolved: { state: 'allowed', source: 'preset', layer: 'default' },
      },
    ],
    exceptions: [AUDITOR],
    agentCount: 34,
  };

  it('shows every area, and asks before overriding a differing agent', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getPermissions).mockResolvedValue(OVERVIEW);
    render(<PermissionList scope={{ kind: 'default' }} />, { wrapper });

    const roomsRow = await screen.findByTestId('permission-row-rooms');
    // An area with no fixed actions still takes a state.
    expect(screen.getByTestId('permission-row-tasks')).toBeInTheDocument();

    await userEvent.click(within(roomsRow).getByRole('radio', { name: 'Ask' }));

    // One agent differs, so the question comes first and nothing is written yet.
    expect(await screen.findByText('Rooms will be set to Ask for everyone.')).toBeInTheDocument();
    expect(screen.getByText('This affects 33 agents now.')).toBeInTheDocument();
    expect(transport.patchPermissionDefaults).not.toHaveBeenCalled();

    await userEvent.click(screen.getByLabelText('security-auditor: Blocked'));
    await userEvent.click(screen.getByRole('button', { name: 'Update selected' }));
    await waitFor(() =>
      expect(transport.patchPermissionDefaults).toHaveBeenCalledWith({
        areas: { rooms: 'ask' },
        applyToAgents: ['a1'],
        surface: 'settings',
      })
    );
  });
});

describe('individual actions', () => {
  const withActions = (
    action: PermissionsResponse['areas'][number]['actions'][number]
  ): PermissionsResponse => ({
    preset: 'full',
    defaults: { areas: {}, actions: {} },
    changeCount: 0,
    filesAndCommands: { stop: 'autonomy', presetStop: 'autonomy', runtimes: [], exceptions: [] },
    areas: [
      {
        id: 'tasks',
        label: 'Tasks & schedules',
        description: 'Tasks',
        floor: false,
        kind: 'state',
        actions: [action],
        resolved: { state: 'allowed', source: 'preset', layer: 'default' },
      },
    ],
    exceptions: [],
    agentCount: 3,
  });

  it('opens every action with its own switch, and says a destructive one still asks', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getPermissions).mockResolvedValue(
      withActions({
        id: 'tasks.delete',
        title: 'Delete a schedule',
        tier: 'destructive',
        resolved: {
          area: 'tasks',
          state: 'ask',
          source: 'preset',
          layer: 'default',
          destructiveAsk: true,
        },
      })
    );
    render(<PermissionList scope={{ kind: 'default' }} />, { wrapper });

    await userEvent.click(await screen.findByRole('button', { name: 'Show individual actions' }));
    const row = screen.getByTestId('permission-action-tasks.delete');
    expect(within(row).getByText('Always asks unless you set it here')).toBeInTheDocument();

    await userEvent.click(within(row).getByRole('radio', { name: 'Allowed' }));
    await waitFor(() =>
      expect(transport.patchPermissionDefaults).toHaveBeenCalledWith({
        actions: { 'tasks.delete': 'allowed' },
        surface: 'settings',
      })
    );
  });

  it('shows a default action change while collapsed, with a Reset', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getPermissions).mockResolvedValue(
      withActions({
        id: 'tasks.create',
        title: 'Create a schedule',
        tier: 'act',
        resolved: { area: 'tasks', state: 'ask', source: 'default-action', layer: 'default' },
      })
    );
    render(<PermissionList scope={{ kind: 'default' }} />, { wrapper });

    expect(await screen.findByText('Except Create a schedule: Ask')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Put Create a schedule back to Tasks & schedules' })
    );
    await waitFor(() =>
      expect(transport.patchPermissionDefaults).toHaveBeenCalledWith({
        actions: { 'tasks.create': null },
        surface: 'settings',
      })
    );
  });
});

describe("an agent's Files & commands row", () => {
  const view = (files: AgentPermissionsResponse['filesAndCommands']): AgentPermissionsResponse => ({
    agentId: 'a1',
    agentName: 'security-auditor',
    overrides: files.source === 'agent' ? { filesAndCommands: files.stop ?? undefined } : {},
    filesAndCommands: files,
    areas: [],
  });

  it('follows everyone until changed, and a change writes the agent’s own stop', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getAgentPermissions).mockResolvedValue(
      view({ stop: 'act', source: 'default', inherited: { stop: 'act', source: 'default' } })
    );
    render(<PermissionList scope={{ kind: 'agent', agentId: 'a1' }} />, { wrapper });

    const row = await screen.findByTestId('permission-row-files');
    expect(within(row).getByText('Same as everyone (Act)')).toBeVisible();
    expect(within(row).queryByRole('button', { name: /Reset/ })).not.toBeInTheDocument();

    await userEvent.click(within(row).getByRole('radio', { name: 'Ask first' }));
    await waitFor(() =>
      expect(transport.patchAgentPermissions).toHaveBeenCalledWith('a1', {
        filesAndCommands: 'ask',
        surface: 'agent-page',
      })
    );
  });

  it('resets its own stop back to the one everyone has', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getAgentPermissions).mockResolvedValue(
      view({ stop: 'ask', source: 'agent', inherited: { stop: 'act', source: 'default' } })
    );
    render(<PermissionList scope={{ kind: 'agent', agentId: 'a1' }} />, { wrapper });

    const row = await screen.findByTestId('permission-row-files');
    expect(within(row).getByText('Everyone else: Act')).toBeVisible();
    await userEvent.click(within(row).getByRole('button', { name: /Reset to default/ }));
    await waitFor(() =>
      expect(transport.patchAgentPermissions).toHaveBeenCalledWith('a1', {
        filesAndCommands: null,
        surface: 'agent-page',
      })
    );
  });

  it('asks before Full autonomy, and sends the yes with the change', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getAgentPermissions).mockResolvedValue(
      view({ stop: 'act', source: 'default', inherited: { stop: 'act', source: 'default' } })
    );
    render(<PermissionList scope={{ kind: 'agent', agentId: 'a1' }} />, { wrapper });

    const row = await screen.findByTestId('permission-row-files');
    await userEvent.click(within(row).getByRole('radio', { name: 'Full autonomy' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(transport.patchAgentPermissions).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: /Turn on|Full autonomy/ }));
    await waitFor(() =>
      expect(transport.patchAgentPermissions).toHaveBeenCalledWith('a1', {
        filesAndCommands: 'autonomy',
        surface: 'agent-page',
        acknowledgeAutonomy: true,
      })
    );
  });
});

describe('PermissionList (agent scope)', () => {
  const rooms = (changedOutsideAt: string | null): AgentPermissionsResponse => ({
    agentId: 'a1',
    agentName: 'security-auditor',
    overrides: { areas: { rooms: 'allowed' } },
    filesAndCommands: {
      stop: 'autonomy',
      source: 'default',
      inherited: { stop: 'autonomy', source: 'default' },
    },
    areas: [
      {
        id: 'rooms',
        label: 'Rooms',
        description: 'Make rooms',
        floor: false,
        kind: 'state',
        actions: [
          {
            id: 'rooms.create',
            title: 'Open a room',
            tier: 'act',
            resolved: { area: 'rooms', state: 'allowed', source: 'agent-area', layer: 'agent' },
          },
        ],
        resolved: { state: 'allowed', source: 'agent-area', layer: 'agent' },
        inherited: { state: 'blocked', source: 'preset', layer: 'default' },
        changedOutsideAt,
      },
    ],
  });

  it('says so when the setting came from an edit made outside DorkOS', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getAgentPermissions).mockResolvedValue(rooms('2026-09-24T00:00:00.000Z'));
    render(<PermissionList scope={{ kind: 'agent', agentId: 'a1' }} />, { wrapper });

    expect(
      await screen.findByText('Changed outside DorkOS · Everyone else: Blocked')
    ).toBeInTheDocument();
  });

  it('shows the plain source otherwise', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getAgentPermissions).mockResolvedValue(rooms(null));
    render(<PermissionList scope={{ kind: 'agent', agentId: 'a1' }} />, { wrapper });

    expect(await screen.findByText('Everyone else: Blocked')).toBeInTheDocument();
    expect(screen.queryByText(/Changed outside DorkOS/)).not.toBeInTheDocument();
  });

  it('lists an Always allow under its area, with a Reset that removes only that action', async () => {
    const { transport, wrapper } = wrap();
    const base = rooms(null);
    const alwaysAllowed: AgentPermissionsResponse = {
      ...base,
      overrides: { actions: { 'rooms.create': 'allowed' } },
      areas: [
        {
          ...base.areas[0]!,
          resolved: { state: 'ask', source: 'preset', layer: 'default' },
          inherited: { state: 'ask', source: 'preset', layer: 'default' },
          actions: [
            {
              id: 'rooms.create',
              title: 'Open a room',
              tier: 'act',
              resolved: { area: 'rooms', state: 'allowed', source: 'agent-action', layer: 'agent' },
            },
          ],
        },
      ],
    };
    vi.mocked(transport.getAgentPermissions).mockResolvedValue(alwaysAllowed);
    render(<PermissionList scope={{ kind: 'agent', agentId: 'a1' }} />, { wrapper });

    expect(await screen.findByText('Except Open a room: Allowed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Put Open a room back to Rooms' }));
    await waitFor(() =>
      expect(transport.patchAgentPermissions).toHaveBeenCalledWith('a1', {
        actions: { 'rooms.create': null },
        surface: 'agent-page',
      })
    );
  });

  it('lists nothing extra when the agent has no action of its own', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getAgentPermissions).mockResolvedValue(rooms(null));
    render(<PermissionList scope={{ kind: 'agent', agentId: 'a1' }} />, { wrapper });

    await screen.findByText('Everyone else: Blocked');
    expect(screen.queryByTestId('permission-action-exceptions-rooms')).not.toBeInTheDocument();
  });
});

describe('when the permissions cannot be read', () => {
  it('says so on the default layer instead of loading forever', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getPermissions).mockRejectedValue(new Error('not here'));
    render(<PermissionList scope={{ kind: 'default' }} />, { wrapper });

    expect(await screen.findByText('Couldn’t read the permissions.')).toBeInTheDocument();
  });

  it('says so for the history instead of claiming there is none', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getPermissionHistory).mockRejectedValue(new Error('not here'));
    render(<PermissionHistory />, { wrapper });

    expect(await screen.findByText('Couldn’t read the history.')).toBeInTheDocument();
    expect(screen.queryByText('No permission changes yet.')).not.toBeInTheDocument();
  });
});
