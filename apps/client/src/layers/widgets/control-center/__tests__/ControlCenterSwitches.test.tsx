// @vitest-environment jsdom
/**
 * The Control Center's power switches: each writes the patch it promises, the
 * mesh switch reads the real topology rule, standing permissions is gated on
 * Require login, and the concurrency stepper refuses a value outside 1–10.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import type { TopologyView } from '@dorkos/shared/mesh-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ControlCenterSwitches } from '../ui/ControlCenterSwitches';

const CLOSED_MESH: TopologyView = {
  callerNamespace: '*',
  namespaces: [],
  accessRules: [],
  openMesh: false,
};

function makeConfig(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    approvals: { standingGrants: true },
    auth: { enabled: true },
    claudeCode: { persistentSession: true },
    scheduler: { maxConcurrentRuns: 4 },
    // All five or none: `useRoomTurnLimits` reads them as a set, so a partial
    // block is the "server too old to say" state rather than a smaller answer.
    rooms: {
      turnLimitsEnabled: true,
      maxAgentDepth: 30,
      maxTurnsPerAgentPerCascade: 10,
      maxAutomaticTurnsPerRoomPerHour: 1000,
      maxAutomaticTurnsTotalPerHour: 5000,
    },
    ...over,
  } as unknown as ServerConfig;
}

function harness(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return Wrapper;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('ControlCenterSwitches', () => {
  it('warm agents reflects config and writes the runtimes patch', async () => {
    const transport = createMockTransport({
      getConfig: vi.fn().mockResolvedValue(makeConfig()),
      getMeshTopology: vi.fn().mockResolvedValue(CLOSED_MESH),
      updateConfig: vi.fn().mockResolvedValue(undefined),
    });
    render(<ControlCenterSwitches />, { wrapper: harness(transport) });

    const warm = await screen.findByRole('switch', { name: 'Warm agents' });
    expect(warm).toBeChecked();
    fireEvent.click(warm);
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        runtimes: { claudeCode: { persistentSession: false } },
      })
    );
  });

  it('standing permissions is off and disabled when Require login is off', async () => {
    const transport = createMockTransport({
      getConfig: vi
        .fn()
        .mockResolvedValue(makeConfig({ auth: { enabled: false } } as Partial<ServerConfig>)),
      getMeshTopology: vi.fn().mockResolvedValue(CLOSED_MESH),
    });
    render(<ControlCenterSwitches />, { wrapper: harness(transport) });

    const grants = await screen.findByRole('switch', { name: 'Standing permissions' });
    expect(grants).toBeDisabled();
    expect(grants).not.toBeChecked();
  });

  it('the mesh switch reads topology.openMesh, not a local boolean', async () => {
    const transport = createMockTransport({
      getConfig: vi.fn().mockResolvedValue(makeConfig()),
      getMeshTopology: vi.fn().mockResolvedValue({ ...CLOSED_MESH, openMesh: true }),
    });
    render(<ControlCenterSwitches />, { wrapper: harness(transport) });

    const mesh = await screen.findByRole('switch', {
      name: 'Let all my agents talk to each other',
    });
    await waitFor(() => expect(mesh).toBeChecked());
  });

  it('limit automatic replies reflects config and writes the rooms patch', async () => {
    const transport = createMockTransport({
      getConfig: vi.fn().mockResolvedValue(makeConfig()),
      getMeshTopology: vi.fn().mockResolvedValue(CLOSED_MESH),
      updateConfig: vi.fn().mockResolvedValue(undefined),
    });
    render(<ControlCenterSwitches />, { wrapper: harness(transport) });

    const limits = await screen.findByRole('switch', { name: 'Limit automatic replies' });
    await waitFor(() => expect(limits).toBeEnabled());
    expect(limits).toBeChecked();
    fireEvent.click(limits);
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        rooms: { turnLimitsEnabled: false },
      })
    );
  });

  it('says what turning the limits off costs, in the words Settings uses', async () => {
    const transport = createMockTransport({
      getConfig: vi.fn().mockResolvedValue(
        makeConfig({
          rooms: {
            turnLimitsEnabled: false,
            maxAgentDepth: 30,
            maxTurnsPerAgentPerCascade: 10,
            maxAutomaticTurnsPerRoomPerHour: 1000,
            maxAutomaticTurnsTotalPerHour: 5000,
          },
        } as unknown as Partial<ServerConfig>)
      ),
      getMeshTopology: vi.fn().mockResolvedValue(CLOSED_MESH),
    });
    render(<ControlCenterSwitches />, { wrapper: harness(transport) });

    const limits = await screen.findByRole('switch', { name: 'Limit automatic replies' });
    await waitFor(() => expect(limits).not.toBeChecked());
    expect(
      screen.getByText(
        'Agents can reply to each other without limit. The Stop button is the only brake.'
      )
    ).toBeInTheDocument();
  });

  it('holds the limits switch until the server has said what it is', async () => {
    // A server too old to report `rooms.*` cannot be described, and a switch
    // drawn from a guess is a switch somebody flips into a write they did not
    // mean. Held rather than hidden, so the panel does not change shape.
    const transport = createMockTransport({
      getConfig: vi.fn().mockResolvedValue(makeConfig({ rooms: undefined })),
      getMeshTopology: vi.fn().mockResolvedValue(CLOSED_MESH),
      updateConfig: vi.fn().mockResolvedValue(undefined),
    });
    render(<ControlCenterSwitches />, { wrapper: harness(transport) });

    const limits = await screen.findByRole('switch', { name: 'Limit automatic replies' });
    await waitFor(() => expect(limits).toBeDisabled());
    fireEvent.click(limits);
    expect(transport.updateConfig).not.toHaveBeenCalled();
  });

  it('the concurrency stepper writes a valid value and refuses one out of range', async () => {
    const transport = createMockTransport({
      getConfig: vi.fn().mockResolvedValue(makeConfig()),
      getMeshTopology: vi.fn().mockResolvedValue(CLOSED_MESH),
      updateConfig: vi.fn().mockResolvedValue(undefined),
    });
    render(<ControlCenterSwitches />, { wrapper: harness(transport) });

    const input = await screen.findByLabelText('Scheduled runs at once');

    // Out of range: refused, no write.
    fireEvent.change(input, { target: { value: '11' } });
    fireEvent.blur(input);
    expect(transport.updateConfig).not.toHaveBeenCalled();

    // In range: written.
    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({ scheduler: { maxConcurrentRuns: 8 } })
    );
  });
});
