/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { TopologyView } from '@dorkos/shared/mesh-schemas';

// ---------------------------------------------------------------------------
// Mocks — must be before imports
// ---------------------------------------------------------------------------

// Mock Sheet components — portals don't work in jsdom, so render children directly.
// Do not spread the actual module: the real Sheet uses portals and would double-render.
vi.mock('@/layers/shared/ui', () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  SheetFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Badge: ({
    children,
    variant: _v,
    className: _c,
  }: {
    children: React.ReactNode;
    variant?: string;
    className?: string;
  }) => <span>{children}</span>,
  Button: ({
    children,
    onClick,
    variant: _v,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    variant?: string;
  }) => <button onClick={onClick}>{children}</button>,
}));

const mockUseTopology = vi.fn<() => { data: TopologyView | undefined }>(() => ({
  data: undefined,
}));
vi.mock('@/layers/entities/mesh', () => ({
  useTopology: () => mockUseTopology(),
}));

const mockUseAgentVisual = vi.fn<
  (agent: unknown, cwd: unknown) => { color: string; emoji: string }
>(() => ({ color: '#ff0000', emoji: '🤖' }));
vi.mock('@/layers/entities/agent', () => ({
  useAgentVisual: (agent: unknown, cwd: unknown) => mockUseAgentVisual(agent, cwd),
}));

// Mock formatRelativeTime to produce predictable output
vi.mock('../lib/format-relative-time', () => ({
  formatRelativeTime: (_iso: string) => '5m',
}));

import { OfflineAgentDetailSheet } from '../ui/OfflineAgentDetailSheet';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTopologyView(agents: Partial<Parameters<typeof makeAgent>[0]>[] = []): TopologyView {
  return {
    callerNamespace: 'default',
    namespaces: [
      {
        namespace: 'default',
        agentCount: agents.length,
        agents: agents.map((overrides) => makeAgent(overrides)),
      },
    ],
    accessRules: [],
  };
}

function makeAgent(
  overrides: Partial<{
    id: string;
    name: string;
    healthStatus: 'active' | 'inactive' | 'stale' | 'unreachable';
    runtime: 'claude-code' | 'cursor' | 'codex' | 'other';
    lastSeenAt: string | null;
    projectPath: string;
  }> = {}
) {
  return {
    id: overrides.id ?? 'agent-1',
    name: overrides.name ?? 'Test Agent',
    description: '',
    runtime: overrides.runtime ?? ('claude-code' as const),
    capabilities: [],
    behavior: { responseMode: 'always' as const },
    namespace: 'default',
    registeredAt: new Date().toISOString(),
    registeredBy: 'test',
    enabledToolGroups: {},
    personaEnabled: true,
    projectPath: overrides.projectPath ?? '/projects/test',
    healthStatus: overrides.healthStatus ?? ('unreachable' as const),
    relayAdapters: [],
    relaySubject: null,
    taskCount: 0,
    lastSeenAt: overrides.lastSeenAt ?? null,
    lastSeenEvent: null,
  };
}

function renderSheet(props: { open?: boolean; onClose?: () => void } = {}) {
  const onClose = props.onClose ?? vi.fn();
  render(<OfflineAgentDetailSheet open={props.open ?? true} onClose={onClose} />);
  return { onClose };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OfflineAgentDetailSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAgentVisual.mockReturnValue({ color: '#ff0000', emoji: '🤖' });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders "All agents are online" when no unreachable agents exist', () => {
    mockUseTopology.mockReturnValue({
      data: makeTopologyView([{ healthStatus: 'active' }, { healthStatus: 'inactive' }]),
    });

    renderSheet();

    expect(screen.getByText('All agents are online')).toBeInTheDocument();
  });

  it('renders "All agents are online" when topology data is undefined', () => {
    mockUseTopology.mockReturnValue({ data: undefined });

    renderSheet();

    expect(screen.getByText('All agents are online')).toBeInTheDocument();
  });

  it('renders offline agent rows when unreachable agents exist', () => {
    mockUseTopology.mockReturnValue({
      data: makeTopologyView([
        { id: 'a1', name: 'Alpha Agent', healthStatus: 'unreachable' },
        { id: 'a2', name: 'Beta Agent', healthStatus: 'unreachable' },
      ]),
    });

    renderSheet();

    expect(screen.getByText('Alpha Agent')).toBeInTheDocument();
    expect(screen.getByText('Beta Agent')).toBeInTheDocument();
    expect(screen.queryByText('All agents are online')).not.toBeInTheDocument();
  });

  it('only shows unreachable agents and excludes active/inactive/stale ones', () => {
    mockUseTopology.mockReturnValue({
      data: makeTopologyView([
        { id: 'a1', name: 'Offline Agent', healthStatus: 'unreachable' },
        { id: 'a2', name: 'Active Agent', healthStatus: 'active' },
        { id: 'a3', name: 'Stale Agent', healthStatus: 'stale' },
      ]),
    });

    renderSheet();

    expect(screen.getByText('Offline Agent')).toBeInTheDocument();
    expect(screen.queryByText('Active Agent')).not.toBeInTheDocument();
    expect(screen.queryByText('Stale Agent')).not.toBeInTheDocument();
  });

  it('shows plural description when multiple agents are unreachable', () => {
    mockUseTopology.mockReturnValue({
      data: makeTopologyView([
        { id: 'a1', name: 'Agent One', healthStatus: 'unreachable' },
        { id: 'a2', name: 'Agent Two', healthStatus: 'unreachable' },
        { id: 'a3', name: 'Agent Three', healthStatus: 'unreachable' },
      ]),
    });

    renderSheet();

    expect(screen.getByText('3 agents unreachable')).toBeInTheDocument();
  });

  it('shows singular description when exactly one agent is unreachable', () => {
    mockUseTopology.mockReturnValue({
      data: makeTopologyView([{ id: 'a1', name: 'Solo Agent', healthStatus: 'unreachable' }]),
    });

    renderSheet();

    expect(screen.getByText('1 agent unreachable')).toBeInTheDocument();
  });

  it('shows zero count description when no agents are unreachable', () => {
    mockUseTopology.mockReturnValue({
      data: makeTopologyView([{ healthStatus: 'active' }]),
    });

    renderSheet();

    expect(screen.getByText('0 agents unreachable')).toBeInTheDocument();
  });

  it('shows last seen time for agents with lastSeenAt set', () => {
    mockUseTopology.mockReturnValue({
      data: makeTopologyView([
        {
          id: 'a1',
          name: 'Timed Agent',
          healthStatus: 'unreachable',
          lastSeenAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        },
      ]),
    });

    renderSheet();

    // formatRelativeTime is mocked to return "5m", component appends " ago"
    expect(screen.getByText('5m ago')).toBeInTheDocument();
  });

  it('does not show last seen time for agents without lastSeenAt', () => {
    mockUseTopology.mockReturnValue({
      data: makeTopologyView([
        { id: 'a1', name: 'No Time Agent', healthStatus: 'unreachable', lastSeenAt: null },
      ]),
    });

    renderSheet();

    expect(screen.queryByText(/ago/)).not.toBeInTheDocument();
  });

  it('shows the Unreachable badge for each offline agent', () => {
    mockUseTopology.mockReturnValue({
      data: makeTopologyView([
        { id: 'a1', name: 'Agent One', healthStatus: 'unreachable' },
        { id: 'a2', name: 'Agent Two', healthStatus: 'unreachable' },
      ]),
    });

    renderSheet();

    const badges = screen.getAllByText('Unreachable');
    expect(badges).toHaveLength(2);
  });

  it('shows runtime badge when agent has a runtime value', () => {
    mockUseTopology.mockReturnValue({
      data: makeTopologyView([
        { id: 'a1', name: 'Claude Agent', healthStatus: 'unreachable', runtime: 'claude-code' },
      ]),
    });

    renderSheet();

    expect(screen.getByText('claude-code')).toBeInTheDocument();
  });

  it('flattens agents across multiple namespaces', () => {
    const topology: TopologyView = {
      callerNamespace: 'default',
      namespaces: [
        {
          namespace: 'ns-1',
          agentCount: 1,
          agents: [makeAgent({ id: 'a1', name: 'NS1 Agent', healthStatus: 'unreachable' })],
        },
        {
          namespace: 'ns-2',
          agentCount: 1,
          agents: [makeAgent({ id: 'a2', name: 'NS2 Agent', healthStatus: 'unreachable' })],
        },
      ],
      accessRules: [],
    };
    mockUseTopology.mockReturnValue({ data: topology });

    renderSheet();

    expect(screen.getByText('NS1 Agent')).toBeInTheDocument();
    expect(screen.getByText('NS2 Agent')).toBeInTheDocument();
    expect(screen.getByText('2 agents unreachable')).toBeInTheDocument();
  });

  it('calls onClose when the Close button is clicked', () => {
    mockUseTopology.mockReturnValue({ data: makeTopologyView([]) });
    const { onClose } = renderSheet();

    fireEvent.click(screen.getByRole('button', { name: /close/i }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders the agent emoji from useAgentVisual', () => {
    mockUseAgentVisual.mockReturnValue({ color: '#00ff00', emoji: '🦾' });
    mockUseTopology.mockReturnValue({
      data: makeTopologyView([{ id: 'a1', name: 'Robo Agent', healthStatus: 'unreachable' }]),
    });

    renderSheet();

    expect(screen.getByText('🦾')).toBeInTheDocument();
  });
});
