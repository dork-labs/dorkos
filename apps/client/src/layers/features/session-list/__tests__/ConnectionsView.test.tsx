// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { AgentToolStatus } from '@/layers/entities/agent';
import type { AdapterListItem } from '@dorkos/shared/transport';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
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

// Mock app store — capture setRelayOpen / setMeshOpen calls
const mockSetRelayOpen = vi.fn();
const mockSetMeshOpen = vi.fn();
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { setRelayOpen: mockSetRelayOpen, setMeshOpen: mockSetMeshOpen };
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

/** Build a minimal AgentManifest for testing. */
function makeAgent(id: string, name: string): AgentManifest {
  return { id, name } as AgentManifest;
}

describe('ConnectionsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRelayAdapters.mockReturnValue({ data: [] });
    mockRegisteredAgents.mockReturnValue({ data: { agents: [] } });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders Adapters section with adapter names and status', () => {
    mockRelayAdapters.mockReturnValue({
      data: [
        makeAdapter('a1', 'Telegram', 'connected'),
        makeAdapter('a2', 'Slack', 'disconnected'),
      ],
    });
    render(<ConnectionsView toolStatus={enabledToolStatus} />, { wrapper: Wrapper });
    expect(screen.getByText('Adapters')).toBeInTheDocument();
    expect(screen.getByText('Telegram')).toBeInTheDocument();
    expect(screen.getByText('Slack')).toBeInTheDocument();
  });

  it('renders Agents section with agent names', () => {
    mockRegisteredAgents.mockReturnValue({
      data: { agents: [makeAgent('ag1', 'Deployer')] },
    });
    render(<ConnectionsView toolStatus={enabledToolStatus} />, { wrapper: Wrapper });
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Deployer')).toBeInTheDocument();
  });

  it('hides Adapters section when Relay is disabled-by-server', () => {
    const toolStatus: AgentToolStatus = { ...enabledToolStatus, relay: 'disabled-by-server' };
    render(<ConnectionsView toolStatus={toolStatus} />, { wrapper: Wrapper });
    expect(screen.queryByText('Adapters')).not.toBeInTheDocument();
  });

  it('shows disabled state when Relay is disabled-by-agent', () => {
    const toolStatus: AgentToolStatus = { ...enabledToolStatus, relay: 'disabled-by-agent' };
    render(<ConnectionsView toolStatus={toolStatus} />, { wrapper: Wrapper });
    expect(screen.getByText('Relay disabled for this agent')).toBeInTheDocument();
  });

  it('shows disabled state when Mesh is disabled-by-agent', () => {
    const toolStatus: AgentToolStatus = { ...enabledToolStatus, mesh: 'disabled-by-agent' };
    render(<ConnectionsView toolStatus={toolStatus} />, { wrapper: Wrapper });
    expect(screen.getByText('Mesh disabled for this agent')).toBeInTheDocument();
  });

  it('shows empty state when both sections hidden', () => {
    const toolStatus: AgentToolStatus = {
      ...enabledToolStatus,
      relay: 'disabled-by-server',
      mesh: 'disabled-by-server',
    };
    render(<ConnectionsView toolStatus={toolStatus} />, { wrapper: Wrapper });
    expect(screen.getByText('No connections configured')).toBeInTheDocument();
  });

  it('Open Relay button calls setRelayOpen(true)', () => {
    render(<ConnectionsView toolStatus={enabledToolStatus} />, { wrapper: Wrapper });
    const btn = screen.getByText(/Open Relay/);
    fireEvent.click(btn);
    expect(mockSetRelayOpen).toHaveBeenCalledWith(true);
  });

  it('Open Mesh button calls setMeshOpen(true)', () => {
    render(<ConnectionsView toolStatus={enabledToolStatus} />, { wrapper: Wrapper });
    const btn = screen.getByText(/Open Mesh/);
    fireEvent.click(btn);
    expect(mockSetMeshOpen).toHaveBeenCalledWith(true);
  });

  it('renders empty adapter state when no adapters configured', () => {
    render(<ConnectionsView toolStatus={enabledToolStatus} />, { wrapper: Wrapper });
    expect(screen.getByText('No adapters configured')).toBeInTheDocument();
  });

  it('renders empty agents state when no agents registered', () => {
    render(<ConnectionsView toolStatus={enabledToolStatus} />, { wrapper: Wrapper });
    expect(screen.getByText('No agents registered')).toBeInTheDocument();
  });

  it('shows adapter state text (capitalized)', () => {
    mockRelayAdapters.mockReturnValue({
      data: [makeAdapter('a1', 'Telegram', 'connected')],
    });
    render(<ConnectionsView toolStatus={enabledToolStatus} />, { wrapper: Wrapper });
    expect(screen.getByText('connected')).toBeInTheDocument();
  });
});
