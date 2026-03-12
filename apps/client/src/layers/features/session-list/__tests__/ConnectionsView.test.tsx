// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { AgentToolStatus } from '@/layers/entities/agent';
import type { AdapterListItem } from '@dorkos/shared/transport';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import { SidebarProvider } from '@/layers/shared/ui';
import { ConnectionsView } from '../ui/ConnectionsView';

// Mock useRelayAdapters
const mockRelayAdapters = vi.fn<() => { data: AdapterListItem[] }>(() => ({ data: [] }));
vi.mock('@/layers/entities/relay/model/use-relay-adapters', () => ({
  useRelayAdapters: () => mockRelayAdapters(),
}));

// Mock useRegisteredAgents
const mockRegisteredAgents = vi.fn<() => { data: { agents: AgentManifest[] } | undefined }>(() => ({
  data: { agents: [] },
}));
vi.mock('@/layers/entities/mesh/model/use-mesh-agents', () => ({
  useRegisteredAgents: () => mockRegisteredAgents(),
}));

// Mock useAgentAccess
const mockAgentAccess = vi.fn<() => { data: { agents: AgentManifest[] } | undefined; isLoading: boolean }>(() => ({
  data: undefined,
  isLoading: false,
}));
vi.mock('@/layers/entities/mesh/model/use-mesh-access', () => ({
  useAgentAccess: () => mockAgentAccess(),
  useUpdateAccessRule: vi.fn(),
}));

// Mock useBindings
const mockBindings = vi.fn<() => { data: AdapterBinding[] }>(() => ({ data: [] }));
vi.mock('@/layers/entities/binding/model/use-bindings', () => ({
  useBindings: () => mockBindings(),
}));

// Mock useMcpConfig
const mockMcpConfig = vi.fn<() => { data: { servers: { name: string; type: string; status?: string }[] } | undefined }>(() => ({
  data: { servers: [] },
}));
vi.mock('@/layers/entities/agent/model/use-mcp-config', () => ({
  useMcpConfig: () => mockMcpConfig(),
}));

// Mock app store — capture setRelayOpen / setMeshOpen / setAgentDialogOpen calls
const mockSetRelayOpen = vi.fn();
const mockSetMeshOpen = vi.fn();
const mockSetAgentDialogOpen = vi.fn();
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      setRelayOpen: mockSetRelayOpen,
      setMeshOpen: mockSetMeshOpen,
      setAgentDialogOpen: mockSetAgentDialogOpen,
      selectedCwd: null,
    };
    return selector ? selector(state) : state;
  },
}));

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

  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return <SidebarProvider>{children}</SidebarProvider>;
}

const enabledToolStatus: AgentToolStatus = {
  pulse: 'enabled',
  relay: 'enabled',
  mesh: 'enabled',
  adapter: 'enabled',
};

/** Build an AdapterListItem with the nested config/status shape. */
function makeAdapter(
  id: string,
  displayName: string,
  state: 'connected' | 'disconnected' | 'error' | 'starting' | 'stopping',
): AdapterListItem {
  return {
    config: {
      id,
      type: 'telegram',
      enabled: true,
      config: { token: 'test-token', mode: 'polling' },
    },
    status: {
      id,
      type: 'telegram',
      displayName,
      state,
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
    },
  };
}

/** Build a minimal binding for testing. */
function makeBinding(adapterId: string, agentId: string): AdapterBinding {
  return {
    id: `${adapterId}-${agentId}`,
    adapterId,
    agentId,
    projectPath: '/test',
    sessionStrategy: 'per-chat',
    label: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Build a minimal AgentManifest for testing. */
function makeAgent(id: string, name: string): AgentManifest {
  return { id, name } as AgentManifest;
}

/** Build a minimal MCP server entry for testing. */
function makeMcpServer(name: string, status?: string): { name: string; type: string; status?: string } {
  return { name, type: 'stdio', ...(status !== undefined && { status }) };
}

const AGENT_ID = 'agent-1';

describe('ConnectionsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRelayAdapters.mockReturnValue({ data: [] });
    mockRegisteredAgents.mockReturnValue({ data: { agents: [] } });
    mockBindings.mockReturnValue({ data: [] });
    mockMcpConfig.mockReturnValue({ data: { servers: [] } });
    mockAgentAccess.mockReturnValue({ data: undefined, isLoading: false });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders Adapters section with adapter names and status for bound adapters', () => {
    mockRelayAdapters.mockReturnValue({
      data: [
        makeAdapter('a1', 'Telegram', 'connected'),
        makeAdapter('a2', 'Slack', 'disconnected'),
      ],
    });
    mockBindings.mockReturnValue({
      data: [makeBinding('a1', AGENT_ID), makeBinding('a2', AGENT_ID)],
    });
    render(<ConnectionsView toolStatus={enabledToolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
    expect(screen.getByText('Adapters')).toBeInTheDocument();
    expect(screen.getByText('Telegram')).toBeInTheDocument();
    expect(screen.getByText('Slack')).toBeInTheDocument();
  });

  it('filters out adapters not bound to the current agent', () => {
    mockRelayAdapters.mockReturnValue({
      data: [
        makeAdapter('a1', 'Telegram', 'connected'),
        makeAdapter('a2', 'Slack', 'disconnected'),
      ],
    });
    // Only a1 is bound to AGENT_ID
    mockBindings.mockReturnValue({ data: [makeBinding('a1', AGENT_ID)] });
    render(<ConnectionsView toolStatus={enabledToolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
    expect(screen.getByText('Telegram')).toBeInTheDocument();
    expect(screen.queryByText('Slack')).not.toBeInTheDocument();
  });

  it('renders Agents section with agent names', () => {
    mockRegisteredAgents.mockReturnValue({
      data: { agents: [makeAgent('ag1', 'Deployer')] },
    });
    render(<ConnectionsView toolStatus={enabledToolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Deployer')).toBeInTheDocument();
  });

  it('hides Adapters section when Relay is disabled-by-server', () => {
    const toolStatus: AgentToolStatus = { ...enabledToolStatus, relay: 'disabled-by-server' };
    render(<ConnectionsView toolStatus={toolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
    expect(screen.queryByText('Adapters')).not.toBeInTheDocument();
  });

  it('shows disabled state when Relay is disabled-by-agent', () => {
    const toolStatus: AgentToolStatus = { ...enabledToolStatus, relay: 'disabled-by-agent' };
    render(<ConnectionsView toolStatus={toolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
    expect(screen.getByText('Relay disabled for this agent')).toBeInTheDocument();
  });

  it('shows disabled state when Mesh is disabled-by-agent', () => {
    const toolStatus: AgentToolStatus = { ...enabledToolStatus, mesh: 'disabled-by-agent' };
    render(<ConnectionsView toolStatus={toolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
    expect(screen.getByText('Mesh disabled for this agent')).toBeInTheDocument();
  });

  it('hides Adapters and Agents sections when both disabled-by-server, but still shows Tools', () => {
    const toolStatus: AgentToolStatus = {
      ...enabledToolStatus,
      relay: 'disabled-by-server',
      mesh: 'disabled-by-server',
    };
    render(<ConnectionsView toolStatus={toolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
    expect(screen.queryByText('Adapters')).not.toBeInTheDocument();
    expect(screen.queryByText('Agents')).not.toBeInTheDocument();
    expect(screen.getByText('Tools')).toBeInTheDocument();
  });

  it('Open Relay button calls setRelayOpen(true)', () => {
    render(<ConnectionsView toolStatus={enabledToolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
    const btn = screen.getByText(/Open Relay/);
    fireEvent.click(btn);
    expect(mockSetRelayOpen).toHaveBeenCalledWith(true);
  });

  it('Open Mesh button calls setMeshOpen(true)', () => {
    render(<ConnectionsView toolStatus={enabledToolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
    const btn = screen.getByText(/Open Mesh/);
    fireEvent.click(btn);
    expect(mockSetMeshOpen).toHaveBeenCalledWith(true);
  });

  it('renders empty adapter state when no adapters configured', () => {
    render(<ConnectionsView toolStatus={enabledToolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
    expect(screen.getByText('No adapters configured')).toBeInTheDocument();
  });

  it('renders empty agents state when no agents registered', () => {
    render(<ConnectionsView toolStatus={enabledToolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
    expect(screen.getByText('No agents registered')).toBeInTheDocument();
  });

  it('shows adapter state text (capitalized)', () => {
    mockRelayAdapters.mockReturnValue({
      data: [makeAdapter('a1', 'Telegram', 'connected')],
    });
    mockBindings.mockReturnValue({ data: [makeBinding('a1', AGENT_ID)] });
    render(<ConnectionsView toolStatus={enabledToolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
    expect(screen.getByText('connected')).toBeInTheDocument();
  });

  describe('agent filtering via useAgentAccess', () => {
    it('shows all agents when no agentId is provided', () => {
      mockRegisteredAgents.mockReturnValue({
        data: { agents: [makeAgent('ag1', 'Alpha'), makeAgent('ag2', 'Beta')] },
      });
      render(<ConnectionsView toolStatus={enabledToolStatus} agentId={null} />, { wrapper: Wrapper });
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });

    it('shows only reachable agents when agentId is set and access data is resolved', () => {
      mockRegisteredAgents.mockReturnValue({
        data: { agents: [makeAgent('ag1', 'Alpha'), makeAgent('ag2', 'Beta'), makeAgent('ag3', 'Gamma')] },
      });
      // Only ag1 and ag3 are reachable
      mockAgentAccess.mockReturnValue({
        data: { agents: [makeAgent('ag1', 'Alpha'), makeAgent('ag3', 'Gamma')] },
        isLoading: false,
      });
      render(<ConnectionsView toolStatus={enabledToolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.queryByText('Beta')).not.toBeInTheDocument();
      expect(screen.getByText('Gamma')).toBeInTheDocument();
    });

    it('shows all agents while access query is loading (avoids flicker)', () => {
      mockRegisteredAgents.mockReturnValue({
        data: { agents: [makeAgent('ag1', 'Alpha'), makeAgent('ag2', 'Beta')] },
      });
      mockAgentAccess.mockReturnValue({ data: undefined, isLoading: true });
      render(<ConnectionsView toolStatus={enabledToolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });

    it('shows all agents when access query returns an error (fail open)', () => {
      mockRegisteredAgents.mockReturnValue({
        data: { agents: [makeAgent('ag1', 'Alpha'), makeAgent('ag2', 'Beta')] },
      });
      // Error state: data is undefined, isLoading is false
      mockAgentAccess.mockReturnValue({ data: undefined, isLoading: false });
      render(<ConnectionsView toolStatus={enabledToolStatus} agentId={AGENT_ID} />, { wrapper: Wrapper });
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });
  });

  describe('agents cap (AGENT_CAP = 3)', () => {
    it('shows all agents when count is at or below cap', () => {
      mockRegisteredAgents.mockReturnValue({
        data: {
          agents: [makeAgent('ag1', 'Alpha'), makeAgent('ag2', 'Beta'), makeAgent('ag3', 'Gamma')],
        },
      });
      render(<ConnectionsView toolStatus={enabledToolStatus} agentId={null} />, { wrapper: Wrapper });
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
      expect(screen.getByText('Gamma')).toBeInTheDocument();
      expect(screen.queryByText(/more agent/)).not.toBeInTheDocument();
    });

    it('shows only the first 3 agents and an overflow button when count exceeds cap', () => {
      mockRegisteredAgents.mockReturnValue({
        data: {
          agents: [
            makeAgent('ag1', 'Alpha'),
            makeAgent('ag2', 'Beta'),
            makeAgent('ag3', 'Gamma'),
            makeAgent('ag4', 'Delta'),
            makeAgent('ag5', 'Epsilon'),
          ],
        },
      });
      render(<ConnectionsView toolStatus={enabledToolStatus} agentId={null} />, { wrapper: Wrapper });
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
      expect(screen.getByText('Gamma')).toBeInTheDocument();
      expect(screen.queryByText('Delta')).not.toBeInTheDocument();
      expect(screen.queryByText('Epsilon')).not.toBeInTheDocument();
      expect(screen.getByText('+ 2 more agents reachable →')).toBeInTheDocument();
    });

    it('overflow button opens Mesh panel', () => {
      mockRegisteredAgents.mockReturnValue({
        data: {
          agents: [
            makeAgent('ag1', 'Alpha'),
            makeAgent('ag2', 'Beta'),
            makeAgent('ag3', 'Gamma'),
            makeAgent('ag4', 'Delta'),
          ],
        },
      });
      render(<ConnectionsView toolStatus={enabledToolStatus} agentId={null} />, { wrapper: Wrapper });
      fireEvent.click(screen.getByText('+ 1 more agent reachable →'));
      expect(mockSetMeshOpen).toHaveBeenCalledWith(true);
    });
  });

  describe('MCP servers cap (MCP_CAP = 4)', () => {
    it('shows all MCP servers when count is at or below cap', () => {
      mockMcpConfig.mockReturnValue({
        data: {
          servers: [
            makeMcpServer('alpha'),
            makeMcpServer('beta'),
            makeMcpServer('gamma'),
            makeMcpServer('delta'),
          ],
        },
      });
      render(<ConnectionsView toolStatus={enabledToolStatus} agentId={null} />, { wrapper: Wrapper });
      expect(screen.getByText('alpha')).toBeInTheDocument();
      expect(screen.getByText('beta')).toBeInTheDocument();
      expect(screen.getByText('gamma')).toBeInTheDocument();
      expect(screen.getByText('delta')).toBeInTheDocument();
      expect(screen.queryByText(/more server/)).not.toBeInTheDocument();
    });

    it('shows only the first 4 MCP servers and an overflow button when count exceeds cap', () => {
      mockMcpConfig.mockReturnValue({
        data: {
          servers: [
            makeMcpServer('alpha'),
            makeMcpServer('beta'),
            makeMcpServer('gamma'),
            makeMcpServer('delta'),
            makeMcpServer('epsilon'),
            makeMcpServer('zeta'),
          ],
        },
      });
      render(<ConnectionsView toolStatus={enabledToolStatus} agentId={null} />, { wrapper: Wrapper });
      expect(screen.getByText('alpha')).toBeInTheDocument();
      expect(screen.getByText('beta')).toBeInTheDocument();
      expect(screen.getByText('gamma')).toBeInTheDocument();
      expect(screen.getByText('delta')).toBeInTheDocument();
      expect(screen.queryByText('epsilon')).not.toBeInTheDocument();
      expect(screen.queryByText('zeta')).not.toBeInTheDocument();
      expect(screen.getByText('+ 2 more servers →')).toBeInTheDocument();
    });

    it('overflow button opens agent settings dialog', () => {
      mockMcpConfig.mockReturnValue({
        data: {
          servers: [
            makeMcpServer('alpha'),
            makeMcpServer('beta'),
            makeMcpServer('gamma'),
            makeMcpServer('delta'),
            makeMcpServer('epsilon'),
          ],
        },
      });
      render(<ConnectionsView toolStatus={enabledToolStatus} agentId={null} />, { wrapper: Wrapper });
      fireEvent.click(screen.getByText('+ 1 more server →'));
      expect(mockSetAgentDialogOpen).toHaveBeenCalledWith(true);
    });
  });
});
