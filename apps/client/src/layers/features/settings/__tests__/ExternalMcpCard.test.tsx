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

const LOCAL_TOKEN = 'dork_mcp_local_abc123def456';

const LOCAL_TOKEN_MCP: McpConfig = {
  ...DEFAULT_MCP,
  authConfigured: true,
  authSource: 'local-token',
  localToken: LOCAL_TOKEN,
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

  it('points to Security API keys for authentication in the user-keys (login-on) state', async () => {
    // Purpose: with login on, the local token is inactive and the card shows the
    // existing personal-API-key guidance instead of a token.
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();
    const mcp: McpConfig = { ...DEFAULT_MCP, authConfigured: true, authSource: 'user-keys' };
    render(<ExternalMcpCard mcp={mcp} />, { wrapper: Wrapper });
    await expandCard(user);
    expect(screen.getByText(/personal API key/i)).toBeInTheDocument();
    expect(screen.queryByText('Local MCP token')).not.toBeInTheDocument();
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

  it('renders the local token and a copy control in local-token mode', async () => {
    // Purpose: login-off mode shows the per-instance token in a read-only field
    // with a Copy button so the operator can paste it into their MCP client.
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();
    render(<ExternalMcpCard mcp={LOCAL_TOKEN_MCP} />, { wrapper: Wrapper });
    await expandCard(user);
    expect(screen.getByText('Local MCP token')).toBeInTheDocument();
    expect(screen.getByText(LOCAL_TOKEN)).toBeInTheDocument();
    // A copy control sits next to the token, in addition to the endpoint's — so
    // the expanded card exposes at least two "Copy to clipboard" buttons.
    const copyButtons = screen.getAllByRole('button', { name: /copy to clipboard/i });
    expect(copyButtons.length).toBeGreaterThanOrEqual(2);
  });

  it('embeds the real local token in the setup snippet (not the placeholder)', async () => {
    // Purpose: the paste-ready client config carries the actual token so the user
    // does not have to hand-edit a placeholder.
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();
    render(<ExternalMcpCard mcp={LOCAL_TOKEN_MCP} />, { wrapper: Wrapper });
    await expandCard(user);
    await user.click(screen.getByText('Setup Instructions'));
    const pres = Array.from(document.querySelectorAll('pre'));
    expect(pres.some((p) => p.textContent?.includes(`Bearer ${LOCAL_TOKEN}`))).toBe(true);
    expect(pres.some((p) => p.textContent?.includes('dork_mcp_YOUR_API_KEY'))).toBe(false);
  });

  it('hides the token and shows the environment badge in env mode', async () => {
    // Purpose: an MCP_API_KEY override is the bearer, so the local token does not
    // apply and is never shown.
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();
    const mcp: McpConfig = { ...DEFAULT_MCP, authConfigured: true, authSource: 'env' };
    render(<ExternalMcpCard mcp={mcp} />, { wrapper: Wrapper });
    await expandCard(user);
    expect(screen.getByText('Environment variable')).toBeInTheDocument();
    expect(screen.queryByText('Local MCP token')).not.toBeInTheDocument();
  });

  it('shows an honest fallback in the degenerate none state', async () => {
    // Purpose: if no token could be generated (should not happen in a normal
    // boot), the card says so plainly rather than pretending auth is set.
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();
    render(<ExternalMcpCard mcp={DEFAULT_MCP} />, { wrapper: Wrapper });
    await expandCard(user);
    expect(screen.getByText(/Couldn't generate a local token/i)).toBeInTheDocument();
    expect(screen.queryByText('Local MCP token')).not.toBeInTheDocument();
  });

  it('reads green Enabled in local-token mode and amber No auth only in none', () => {
    // Purpose: the header badge tracks authConfigured — local-token is gated
    // (green), only the degenerate none is unprotected (amber).
    const { Wrapper } = createWrapper();
    const { rerender } = render(<ExternalMcpCard mcp={LOCAL_TOKEN_MCP} />, { wrapper: Wrapper });
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.queryByText('No auth')).not.toBeInTheDocument();

    rerender(<ExternalMcpCard mcp={DEFAULT_MCP} />);
    expect(screen.getByText('No auth')).toBeInTheDocument();
    expect(screen.queryByText('Enabled')).not.toBeInTheDocument();
  });
});
