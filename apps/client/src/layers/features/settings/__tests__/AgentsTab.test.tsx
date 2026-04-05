/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { CatalogEntry } from '@dorkos/shared/relay-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

// --- Relay entity hook mocks ---
let mockRelayEnabled = true;
let mockCatalogData: CatalogEntry[] = [];
const mockToggleAdapter = vi.fn();
const mockUpdateConfig = vi.fn();

vi.mock('@/layers/entities/relay', () => ({
  useRelayEnabled: () => mockRelayEnabled,
  useAdapterCatalog: () => ({ data: mockCatalogData }),
  useToggleAdapter: () => ({ mutate: mockToggleAdapter }),
  useUpdateAdapterConfig: () => ({ mutate: mockUpdateConfig }),
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
});

afterEach(() => {
  cleanup();
  mockRelayEnabled = true;
  mockCatalogData = [];
  mockToggleAdapter.mockReset();
  mockUpdateConfig.mockReset();
});

// Mock Radix dialog portal to render inline
vi.mock('@radix-ui/react-dialog', async () => {
  const actual =
    await vi.importActual<typeof import('@radix-ui/react-dialog')>('@radix-ui/react-dialog');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** Builds a mock claude-code catalog entry for relay adapter tests. */
function makeClaudeCodeEntry(overrides?: Partial<CatalogEntry['instances'][0]>): CatalogEntry {
  return {
    manifest: {
      type: 'claude-code',
      displayName: 'Claude Code',
      description: 'Routes messages to Claude Agent SDK sessions. Auto-configured.',
      category: 'internal',
      builtin: true,
      configFields: [],
      multiInstance: false,
    },
    instances: [
      {
        id: 'claude-code',
        enabled: true,
        config: { maxConcurrent: 3, defaultTimeoutMs: 300000 },
        status: {
          id: 'claude-code',
          type: 'claude-code',
          displayName: 'Claude Code',
          state: 'connected',
          messageCount: { inbound: 0, outbound: 0 },
          errorCount: 0,
        },
        ...overrides,
      },
    ],
  };
}

import { AgentsTab } from '../ui/AgentsTab';

describe('AgentsTab', () => {
  it('shows default agent dropdown when agents exist', async () => {
    const transport = createMockTransport({
      listMeshAgents: vi.fn().mockResolvedValue({
        agents: [
          { id: '1', name: 'dorkbot', runtime: 'claude-code' },
          { id: '2', name: 'my-agent', runtime: 'claude-code' },
        ],
      }),
      getConfig: vi.fn().mockResolvedValue({
        agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' },
      }),
    });

    render(<AgentsTab />, { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(screen.getByText('Default agent')).toBeInTheDocument();
    });
    expect(screen.getByTestId('default-agent-select')).toBeInTheDocument();
  });

  it('does not show dropdown when no agents registered', async () => {
    const transport = createMockTransport({
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [] }),
      getConfig: vi.fn().mockResolvedValue({
        agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' },
      }),
    });

    render(<AgentsTab />, { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(transport.listMeshAgents).toHaveBeenCalled();
    });
    expect(screen.queryByText('Default agent')).not.toBeInTheDocument();
  });

  it('renders the Runtimes section heading', async () => {
    const transport = createMockTransport({
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [] }),
      getConfig: vi.fn().mockResolvedValue({
        agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' },
      }),
    });

    render(<AgentsTab />, { wrapper: createWrapper(transport) });

    expect(screen.getByText('Runtimes')).toBeInTheDocument();
    expect(
      screen.getByText('Configure which runtimes are available for agent sessions.')
    ).toBeInTheDocument();
  });

  it('renders six runtime cards: Claude Code plus five coming-soon agents', async () => {
    const transport = createMockTransport({
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [] }),
      getConfig: vi.fn().mockResolvedValue({
        agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' },
      }),
    });

    render(<AgentsTab />, { wrapper: createWrapper(transport) });

    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('Agent Protocol')).toBeInTheDocument();
    expect(screen.getByText('Pi Agent')).toBeInTheDocument();
    expect(screen.getByText('Gemini CLI')).toBeInTheDocument();
    expect(screen.getByText('Aider')).toBeInTheDocument();
  });

  it('shows Active badge for Claude Code and Coming Soon for the remaining runtimes', async () => {
    const transport = createMockTransport({
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [] }),
      getConfig: vi.fn().mockResolvedValue({
        agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' },
      }),
    });

    render(<AgentsTab />, { wrapper: createWrapper(transport) });

    expect(screen.getByText('Active')).toBeInTheDocument();
    const comingSoonBadges = screen.getAllByText('Coming Soon');
    expect(comingSoonBadges).toHaveLength(5);
  });

  it('shows Claude Code adapter description', async () => {
    const transport = createMockTransport({
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [] }),
      getConfig: vi.fn().mockResolvedValue({
        agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' },
      }),
    });

    render(<AgentsTab />, { wrapper: createWrapper(transport) });

    expect(
      screen.getByText("Anthropic's agentic coding runtime — powers all DorkOS sessions")
    ).toBeInTheDocument();
  });

  // --- New tests for relay-driven Claude Code card ---

  it('reflects persisted enabled state from relay adapter catalog', () => {
    mockCatalogData = [makeClaudeCodeEntry({ enabled: false })];
    const transport = createMockTransport({
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [] }),
      getConfig: vi.fn().mockResolvedValue({ agents: { defaultAgent: 'dorkbot' } }),
    });

    render(<AgentsTab />, { wrapper: createWrapper(transport) });

    const toggle = screen.getByRole('switch');
    expect(toggle.getAttribute('data-state')).toBe('unchecked');
  });

  it('calls toggleAdapter when Claude Code switch is toggled', async () => {
    mockCatalogData = [makeClaudeCodeEntry({ enabled: true })];
    const user = userEvent.setup();
    const transport = createMockTransport({
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [] }),
      getConfig: vi.fn().mockResolvedValue({ agents: { defaultAgent: 'dorkbot' } }),
    });

    render(<AgentsTab />, { wrapper: createWrapper(transport) });

    const toggle = screen.getByRole('switch');
    await user.click(toggle);

    expect(mockToggleAdapter).toHaveBeenCalledWith({ id: 'claude-code', enabled: false });
  });

  it('shows Claude Code as active without toggle when relay is disabled', () => {
    mockRelayEnabled = false;
    mockCatalogData = [];
    const transport = createMockTransport({
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [] }),
      getConfig: vi.fn().mockResolvedValue({ agents: { defaultAgent: 'dorkbot' } }),
    });

    render(<AgentsTab />, { wrapper: createWrapper(transport) });

    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    // No toggle switch when relay is disabled (no adapter instance to toggle)
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('shows persisted config values when Claude Code card is expanded', async () => {
    mockCatalogData = [
      makeClaudeCodeEntry({ config: { maxConcurrent: 5, defaultTimeoutMs: 600000 } }),
    ];
    const user = userEvent.setup();
    const transport = createMockTransport({
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [] }),
      getConfig: vi.fn().mockResolvedValue({ agents: { defaultAgent: 'dorkbot' } }),
    });

    render(<AgentsTab />, { wrapper: createWrapper(transport) });

    // Expand the Claude Code card
    await user.click(screen.getByText('Claude Code'));

    expect(screen.getByText('Max concurrent sessions')).toBeInTheDocument();
    expect(screen.getByText('Default timeout')).toBeInTheDocument();
    expect(screen.getByDisplayValue('5')).toBeInTheDocument();
    expect(screen.getByDisplayValue('600000')).toBeInTheDocument();
  });
});
