// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ExternalMcpCard } from '../ui/external-mcp/ExternalMcpCard';
import type { ServerConfig } from '@dorkos/shared/types';

type McpConfig = NonNullable<ServerConfig['mcp']>;

const DEFAULT_MCP: McpConfig = {
  enabled: true,
  authConfigured: false,
  authSource: 'none',
  endpoint: 'http://localhost:6242/mcp',
  rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const transport = createMockTransport();
  return {
    transport,
    Wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  };
}

/** Click the chevron to expand the card content. */
async function expandCard(user: ReturnType<typeof userEvent.setup>) {
  const btn = screen.getByRole('button', { name: /expand external mcp server settings/i });
  await user.click(btn);
}

describe('ExternalMcpCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders External MCP Server label', () => {
    const { Wrapper } = createWrapper();
    render(<ExternalMcpCard mcp={DEFAULT_MCP} />, { wrapper: Wrapper });
    expect(screen.getByText('External MCP Server')).toBeInTheDocument();
  });

  it('shows Enabled badge when enabled and auth configured', () => {
    const { Wrapper } = createWrapper();
    const mcp: McpConfig = { ...DEFAULT_MCP, authConfigured: true, authSource: 'user-keys' };
    render(<ExternalMcpCard mcp={mcp} />, { wrapper: Wrapper });
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('shows No auth badge when enabled but no auth', () => {
    const { Wrapper } = createWrapper();
    render(<ExternalMcpCard mcp={DEFAULT_MCP} />, { wrapper: Wrapper });
    expect(screen.getByText('No auth')).toBeInTheDocument();
  });

  it('shows Disabled badge when not enabled', () => {
    const { Wrapper } = createWrapper();
    const mcp: McpConfig = { ...DEFAULT_MCP, enabled: false };
    render(<ExternalMcpCard mcp={mcp} />, { wrapper: Wrapper });
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  it('points to Security API keys for authentication when expanded', async () => {
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();
    render(<ExternalMcpCard mcp={DEFAULT_MCP} />, { wrapper: Wrapper });
    await expandCard(user);
    expect(screen.getByText(/personal API key/i)).toBeInTheDocument();
  });

  it('shows Environment variable badge when auth source is env', async () => {
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();
    const mcp: McpConfig = { ...DEFAULT_MCP, authConfigured: true, authSource: 'env' };
    render(<ExternalMcpCard mcp={mcp} />, { wrapper: Wrapper });
    await expandCard(user);
    expect(screen.getByText('Environment variable')).toBeInTheDocument();
  });

  it('renders Setup Instructions as a collapsible section when expanded', async () => {
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();
    render(<ExternalMcpCard mcp={DEFAULT_MCP} />, { wrapper: Wrapper });
    await expandCard(user);
    expect(screen.getByText('Setup Instructions')).toBeInTheDocument();
  });

  it('renders duplicate tool warning when expanded', async () => {
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();
    render(<ExternalMcpCard mcp={DEFAULT_MCP} />, { wrapper: Wrapper });
    await expandCard(user);
    expect(
      screen.getByText('Do not configure this for agents running inside DorkOS.')
    ).toBeInTheDocument();
  });

  it('calls updateConfig when toggle is clicked', async () => {
    const user = userEvent.setup();
    const { Wrapper, transport } = createWrapper();
    render(<ExternalMcpCard mcp={DEFAULT_MCP} />, { wrapper: Wrapper });

    const toggle = screen.getByRole('switch', { name: /toggle external mcp access/i });
    await user.click(toggle);

    expect(transport.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        mcp: expect.objectContaining({ enabled: false }),
      })
    );
  });

  it('shows endpoint URL when expanded', async () => {
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();
    render(<ExternalMcpCard mcp={DEFAULT_MCP} />, { wrapper: Wrapper });
    await expandCard(user);
    expect(screen.getByText('http://localhost:6242/mcp')).toBeInTheDocument();
  });
});
