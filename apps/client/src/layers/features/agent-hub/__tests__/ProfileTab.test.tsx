/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AgentHubProvider, type AgentHubContextValue } from '../model/agent-hub-context';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/session', () => ({
  useSessions: vi.fn(() => ({
    sessions: [
      { id: 's1', cwd: '/home/user/myagent', updatedAt: '2026-01-10T10:00:00Z' },
      { id: 's2', cwd: '/home/user/myagent', updatedAt: '2026-01-09T10:00:00Z' },
      { id: 's3', cwd: '/other/path', updatedAt: '2026-01-08T10:00:00Z' },
    ],
    activeSessionId: 's1',
    setActiveSession: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------
import { ProfileTab } from '../ui/tabs/ProfileTab';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockTransport = createMockTransport();

const mockAgent = {
  id: 'agent-1',
  name: 'my-agent',
  displayName: 'My Agent',
  description: 'An agent for testing',
  runtime: 'claude-code',
  capabilities: [],
  behavior: { responseMode: 'always' },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  registeredAt: '2026-01-01T00:00:00Z',
  registeredBy: 'test',
  traits: { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 },
  conventions: { soul: true, nope: true, dorkosKnowledge: true },
  color: '#6366f1',
  icon: '🤖',
  enabledToolGroups: {},
} as unknown as AgentManifest;

const mockOnUpdate = vi.fn();

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ctx: AgentHubContextValue = {
    agent: mockAgent,
    projectPath: '/home/user/myagent',
    onUpdate: mockOnUpdate,
    onPersonalityUpdate: vi.fn(),
  };
  return (
    <QueryClientProvider client={qc}>
      <TransportProvider transport={mockTransport}>
        <AgentHubProvider value={ctx}>{children}</AgentHubProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProfileTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the agent display name', () => {
    render(<ProfileTab />, { wrapper: Wrapper });
    expect(screen.getByText('My Agent')).toBeInTheDocument();
  });

  it('renders the agent description', () => {
    render(<ProfileTab />, { wrapper: Wrapper });
    expect(screen.getByText('An agent for testing')).toBeInTheDocument();
  });

  it('renders placeholder text when description is empty', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ctx: AgentHubContextValue = {
      agent: { ...mockAgent, description: '' },
      projectPath: '/home/user/myagent',
      onUpdate: mockOnUpdate,
      onPersonalityUpdate: vi.fn(),
    };
    render(
      <QueryClientProvider client={qc}>
        <TransportProvider transport={mockTransport}>
          <AgentHubProvider value={ctx}>
            <ProfileTab />
          </AgentHubProvider>
        </TransportProvider>
      </QueryClientProvider>
    );
    expect(screen.getByText('Add a description...')).toBeInTheDocument();
  });

  it('renders the runtime selector', () => {
    render(<ProfileTab />, { wrapper: Wrapper });
    // SelectTrigger renders the current value as text
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
  });

  it('renders the directory path with tilde shortening', () => {
    render(<ProfileTab />, { wrapper: Wrapper });
    // shortenHomePath converts /home/user/... to ~/...
    expect(screen.getByText('~/myagent')).toBeInTheDocument();
  });

  it('renders the sessions count stat filtered to project path', () => {
    render(<ProfileTab />, { wrapper: Wrapper });
    // 2 of 3 mocked sessions match /home/user/myagent
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders all three stat cards (Sessions, Channels, Tasks)', () => {
    render(<ProfileTab />, { wrapper: Wrapper });
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Channels')).toBeInTheDocument();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
  });

  it('renders the add tag button', () => {
    render(<ProfileTab />, { wrapper: Wrapper });
    expect(screen.getByRole('button', { name: /add/i })).toBeInTheDocument();
  });

  it('clicking display name enters edit mode and shows an input', () => {
    render(<ProfileTab />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('My Agent'));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('My Agent');
  });

  it('blurring the display name input calls onUpdate with new value', () => {
    render(<ProfileTab />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('My Agent'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Updated Name' } });
    fireEvent.blur(input);
    expect(mockOnUpdate).toHaveBeenCalledWith({ displayName: 'Updated Name' });
  });

  it('pressing Enter in the display name input commits the edit', () => {
    render(<ProfileTab />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('My Agent'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Pressed Enter' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockOnUpdate).toHaveBeenCalledWith({ displayName: 'Pressed Enter' });
  });

  it('clicking description enters edit mode', () => {
    render(<ProfileTab />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('An agent for testing'));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('An agent for testing');
  });

  it('blurring the description textarea calls onUpdate with new value', () => {
    render(<ProfileTab />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('An agent for testing'));
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'New description' } });
    fireEvent.blur(textarea);
    expect(mockOnUpdate).toHaveBeenCalledWith({ description: 'New description' });
  });

  it('falls back to agent name when displayName is absent', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ctx: AgentHubContextValue = {
      agent: { ...mockAgent, displayName: undefined },
      projectPath: '/home/user/myagent',
      onUpdate: mockOnUpdate,
      onPersonalityUpdate: vi.fn(),
    };
    render(
      <QueryClientProvider client={qc}>
        <TransportProvider transport={mockTransport}>
          <AgentHubProvider value={ctx}>
            <ProfileTab />
          </AgentHubProvider>
        </TransportProvider>
      </QueryClientProvider>
    );
    expect(screen.getByText('my-agent')).toBeInTheDocument();
  });
});
