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
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';

vi.mock('@/layers/features/agent-settings', () => ({
  PersonalityTab: () => <div data-testid="personality-inner">PersonalityInner</div>,
  ChannelsTab: () => <div data-testid="channels-inner">ChannelsInner</div>,
}));

vi.mock('@/layers/entities/runtime', async (importOriginal) => ({
  // Keep the real descriptor registry — only the capabilities hook is stubbed.
  ...(await importOriginal<typeof import('@/layers/entities/runtime')>()),
  useRuntimeCapabilities: () => ({
    data: { capabilities: { 'claude-code': {}, cursor: {} } },
  }),
}));

import { ConfigTab } from '../ui/tabs/ConfigTab';

const mockTransport = createMockTransport();
const mockOnUpdate = vi.fn();
const mockAgent = {
  id: 'test-id',
  name: 'test',
  displayName: 'Test',
  description: 'A test agent',
  runtime: 'claude-code',
  capabilities: [],
  traits: DEFAULT_TRAITS,
  conventions: { soul: true, nope: true, dorkosKnowledge: true },
} as unknown as AgentManifest;

/** Builds a Wrapper bound to a specific agent, for tests that need non-default agent data. */
function createWrapper(agent: AgentManifest) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ctx: AgentHubContextValue = {
      agent,
      projectPath: '/test/project',
      onUpdate: mockOnUpdate,
      onPersonalityUpdate: vi.fn(),
      previewColor: null,
      onPreviewColor: vi.fn(),
      isPickerOpen: false,
    };
    return (
      <QueryClientProvider client={qc}>
        <TransportProvider transport={mockTransport}>
          <AgentHubProvider value={ctx}>{children}</AgentHubProvider>
        </TransportProvider>
      </QueryClientProvider>
    );
  };
}

const Wrapper = createWrapper(mockAgent);

afterEach(cleanup);

describe('ConfigTab', () => {
  beforeEach(() => vi.clearAllMocks());

  // --- Metadata section ---

  it('renders description field with agent description', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    expect(screen.getByText('A test agent')).toBeInTheDocument();
  });

  it('renders runtime selector', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    expect(screen.getByText('Runtime')).toBeInTheDocument();
  });

  it('renders directory path', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    expect(screen.getByText('Directory')).toBeInTheDocument();
  });

  it('renders capabilities section', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    expect(screen.getByText('Capabilities')).toBeInTheDocument();
  });

  it('renders each capability from the agent manifest', () => {
    const agentWithCapabilities = { ...mockAgent, capabilities: ['read', 'write'] };
    render(<ConfigTab />, { wrapper: createWrapper(agentWithCapabilities) });
    expect(screen.getByText('read')).toBeInTheDocument();
    expect(screen.getByText('write')).toBeInTheDocument();
  });

  it('adding a capability calls onUpdate with the appended capabilities list', () => {
    const agentWithCapabilities = { ...mockAgent, capabilities: ['read'] };
    render(<ConfigTab />, { wrapper: createWrapper(agentWithCapabilities) });
    fireEvent.click(screen.getByText('Add'));
    fireEvent.change(screen.getByPlaceholderText('capability name'), {
      target: { value: 'write' },
    });
    fireEvent.keyDown(screen.getByPlaceholderText('capability name'), { key: 'Enter' });
    expect(mockOnUpdate).toHaveBeenCalledWith({ capabilities: ['read', 'write'] });
  });

  it('removing a capability calls onUpdate with the filtered capabilities list', () => {
    const agentWithCapabilities = { ...mockAgent, capabilities: ['read', 'write'] };
    render(<ConfigTab />, { wrapper: createWrapper(agentWithCapabilities) });
    fireEvent.click(screen.getByLabelText('Remove capability read'));
    expect(mockOnUpdate).toHaveBeenCalledWith({ capabilities: ['write'] });
  });

  // --- Accordion sections ---
  // Note: Tools & MCP moved to Toolkit tab (marketplace-scoped-installs spec)

  it('renders accordion section titles (Channels and Advanced)', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    expect(screen.queryByText('Tools & MCP')).not.toBeInTheDocument();
    expect(screen.getByText('Channels')).toBeInTheDocument();
    expect(screen.getByText('Advanced')).toBeInTheDocument();
  });

  it('accordion sections are collapsed by default', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    expect(screen.queryByTestId('channels-inner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('personality-inner')).not.toBeInTheDocument();
  });

  it('clicking Channels expands to show ChannelsTab content', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('Channels'));
    expect(screen.getByTestId('channels-inner')).toBeInTheDocument();
  });

  it('clicking Advanced expands to show PersonalityTab content', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByTestId('personality-inner')).toBeInTheDocument();
  });

  it('toggling an accordion section closed hides its content', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('Channels'));
    expect(screen.getByTestId('channels-inner')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Channels'));
    expect(screen.queryByTestId('channels-inner')).not.toBeInTheDocument();
  });

  it('section buttons have aria-expanded reflecting open state', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    const channelsButton = screen.getByText('Channels').closest('button')!;
    expect(channelsButton).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(channelsButton);
    expect(channelsButton).toHaveAttribute('aria-expanded', 'true');
  });

  it('multiple sections can be open simultaneously', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('Channels'));
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByTestId('channels-inner')).toBeInTheDocument();
    expect(screen.getByTestId('personality-inner')).toBeInTheDocument();
  });
});
