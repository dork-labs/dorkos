/**
 * @vitest-environment jsdom
 */
/**
 * The permission surfaces: a row says where its state came from and resets to
 * the default, the apply dialog never moves an agent nobody named, and the
 * exceptions chip lists who differs and resets each one.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import type { PermissionException, PermissionsResponse } from '@dorkos/shared/permissions';
import { TransportProvider } from '@/layers/shared/model';

import { PermissionRow } from '../ui/PermissionRow';
import { ApplyToOverridesDialog } from '../ui/ApplyToOverridesDialog';
import { ExceptionsChip } from '../ui/ExceptionsChip';
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
        agents={[AUDITOR, TESTER]}
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
        agents={[{ ...AUDITOR, area: 'reach' }]}
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
        agents={[AUDITOR]}
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

  it('shows only areas that have actions, and asks before overriding a differing agent', async () => {
    const { transport, wrapper } = wrap();
    vi.mocked(transport.getPermissions).mockResolvedValue(OVERVIEW);
    render(<PermissionList scope={{ kind: 'default' }} />, { wrapper });

    expect(await screen.findByTestId('permission-row-rooms')).toBeInTheDocument();
    expect(screen.queryByTestId('permission-row-tasks')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'Ask' }));

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
