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

vi.mock('@/layers/features/agent-settings', () => ({
  PersonalityTab: () => <div data-testid="personality-inner">PersonalityInner</div>,
  ChannelsTab: () => <div data-testid="channels-inner">ChannelsInner</div>,
  ToolsTab: () => <div data-testid="tools-inner">ToolsInner</div>,
}));

import { ConfigTab } from '../ui/tabs/ConfigTab';

const mockTransport = createMockTransport();
const mockAgent = {
  id: 'test-id',
  name: 'test',
  displayName: 'Test',
  runtime: 'claude-code',
  traits: { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 },
  conventions: { soul: true, nope: true, dorkosKnowledge: true },
} as unknown as AgentManifest;

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ctx: AgentHubContextValue = {
    agent: mockAgent,
    projectPath: '/test',
    onUpdate: vi.fn(),
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

describe('ConfigTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders all three accordion section titles', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    expect(screen.getByText('Tools & MCP')).toBeInTheDocument();
    expect(screen.getByText('Channels')).toBeInTheDocument();
    expect(screen.getByText('Advanced')).toBeInTheDocument();
  });

  it('renders the PersonalityRadar chart', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    expect(screen.getByRole('img', { name: 'Personality radar chart' })).toBeInTheDocument();
  });

  it('renders preset pill buttons for all 6 presets', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    // Use getAllByText because 'Balanced' appears in both the archetype heading and the pill
    expect(screen.getAllByText(/Balanced/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/The Hotshot/)).toBeInTheDocument();
    expect(screen.getByText(/The Sage/)).toBeInTheDocument();
    expect(screen.getByText(/The Sentinel/)).toBeInTheDocument();
    expect(screen.getByText(/The Phantom/)).toBeInTheDocument();
    expect(screen.getByText(/Mad Scientist/)).toBeInTheDocument();
  });

  it('shows archetype name with gradient text', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    // Default traits (3,3,3,3,3) match the 'Balanced' preset — heading + pill both render it
    expect(screen.getAllByText('Balanced').length).toBeGreaterThanOrEqual(1);
  });

  it('accordion sections are collapsed by default', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    expect(screen.queryByTestId('tools-inner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('channels-inner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('personality-inner')).not.toBeInTheDocument();
  });

  it('clicking Tools & MCP expands to show ToolsTab content', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('Tools & MCP'));
    expect(screen.getByTestId('tools-inner')).toBeInTheDocument();
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
    fireEvent.click(screen.getByText('Tools & MCP'));
    expect(screen.getByTestId('tools-inner')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Tools & MCP'));
    expect(screen.queryByTestId('tools-inner')).not.toBeInTheDocument();
  });

  it('section buttons have aria-expanded reflecting open state', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    const toolsButton = screen.getByText('Tools & MCP').closest('button')!;
    expect(toolsButton).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toolsButton);
    expect(toolsButton).toHaveAttribute('aria-expanded', 'true');
  });

  it('multiple sections can be open simultaneously', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('Tools & MCP'));
    fireEvent.click(screen.getByText('Channels'));
    expect(screen.getByTestId('tools-inner')).toBeInTheDocument();
    expect(screen.getByTestId('channels-inner')).toBeInTheDocument();
  });

  it('renders the response preview label', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    expect(screen.getByText('How this agent talks')).toBeInTheDocument();
  });

  it('renders the sample response for the active preset', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    // Default traits (3,3,3,3,3) match the Balanced preset
    expect(screen.getByText(/step by step/i)).toBeInTheDocument();
  });

  it('renders meta text below the preview', () => {
    render(<ConfigTab />, { wrapper: Wrapper });
    expect(screen.getByText('sample response · updates with personality')).toBeInTheDocument();
  });
});
