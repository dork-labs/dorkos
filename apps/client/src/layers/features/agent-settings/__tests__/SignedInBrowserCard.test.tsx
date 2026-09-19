/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { agentBrowserConnection, type AgentBrowserPreset } from '@dorkos/shared/agent-browser';
import { TransportProvider } from '@/layers/shared/model';
import { SignedInBrowserCard } from '../ui/SignedInBrowserCard';

const AGENT_ID = '01HZ0000000000000000000001';
const STATE_FILE = '/Users/me/.dork/browser/storage-state.json';

function preset(overrides: Partial<AgentBrowserPreset> = {}): AgentBrowserPreset {
  return {
    stateFile: STATE_FILE,
    saved: true,
    savedAt: '2026-09-19T12:00:00.000Z',
    sites: [
      {
        site: 'github.com',
        cookies: 3,
        expiresAt: '2027-09-19T00:00:00.000Z',
        expired: false,
        pageStorage: false,
      },
      { site: 'linear.app', cookies: 1, expiresAt: null, expired: false, pageStorage: true },
      { site: 'old.example', cookies: 1, expiresAt: null, expired: true, pageStorage: false },
    ],
    loginCommand: 'dorkos browser login',
    server: {
      name: 'browser',
      connection: agentBrowserConnection(STATE_FILE),
    },
    ...overrides,
  };
}

function renderCard(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return render(<SignedInBrowserCard agentId={AGENT_ID} agentLabel="Researcher" />, { wrapper });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SignedInBrowserCard', () => {
  it('names the saved sites (live ones only) and promises no passwords', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getAgentBrowserPreset).mockResolvedValue(preset());
    renderCard(transport);

    expect(await screen.findByText('Signed in to github.com, linear.app.')).toBeInTheDocument();
    expect(screen.getByText(/never sees your passwords/)).toBeInTheDocument();
  });

  it('says how to save a sign-in when there is none yet', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getAgentBrowserPreset).mockResolvedValue(
      preset({ saved: false, savedAt: null, sites: [] })
    );
    renderCard(transport);

    expect(await screen.findByText(/No sign-ins saved yet/)).toBeInTheDocument();
    expect(screen.getByText('dorkos browser login <site>')).toBeInTheDocument();
  });

  it('adds the preset through mcp.add, behind a confirmation that shows the exact command', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getAgentBrowserPreset).mockResolvedValue(preset());
    const approval = {
      status: 'approval_required' as const,
      approvalId: 'appr-1',
      approvalToken: 'tok-1',
      capabilityId: 'mcp.add',
      tier: 'destructive' as const,
      summary: 'Add a managed MCP server',
      expiresAt: '2026-09-19T13:00:00.000Z',
    };
    vi.mocked(transport.addAgentMcpServer)
      .mockResolvedValueOnce({ status: 'approval_required', approval } as never)
      .mockResolvedValueOnce({ status: 'ok', servers: [] });
    vi.mocked(transport.grantApproval).mockResolvedValue(undefined as never);
    renderCard(transport);

    fireEvent.click(await screen.findByRole('button', { name: 'Give it the browser' }));

    expect(
      await screen.findByText(
        `npx -y @playwright/mcp@0.0.82 --isolated --headless --storage-state ${STATE_FILE}`
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Confirm the signed-in browser for Researcher')).toBeInTheDocument();
    expect(transport.addAgentMcpServer).toHaveBeenCalledWith(
      {
        agentId: AGENT_ID,
        name: 'browser',
        connection: preset().server.connection,
      },
      undefined
    );

    fireEvent.click(screen.getByRole('button', { name: 'Confirm & add' }));
    await waitFor(() => expect(transport.grantApproval).toHaveBeenCalledWith('appr-1'));
    await waitFor(() =>
      expect(transport.addAgentMcpServer).toHaveBeenLastCalledWith(expect.anything(), {
        approvalToken: 'tok-1',
      })
    );
  });

  it('says so when the confirmation comes back still waiting for approval', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getAgentBrowserPreset).mockResolvedValue(preset());
    const approval = {
      status: 'approval_required' as const,
      approvalId: 'appr-1',
      approvalToken: 'tok-1',
      capabilityId: 'mcp.add',
      tier: 'destructive' as const,
      summary: 'Add a managed MCP server',
      expiresAt: '2026-09-19T13:00:00.000Z',
    };
    vi.mocked(transport.addAgentMcpServer).mockResolvedValue({
      status: 'approval_required',
      approval,
    } as never);
    vi.mocked(transport.grantApproval).mockResolvedValue(undefined as never);
    renderCard(transport);

    fireEvent.click(await screen.findByRole('button', { name: 'Give it the browser' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & add' }));
    expect(
      await screen.findByText('The browser still needs approval. Try again.')
    ).toBeInTheDocument();
  });

  it('reads an empty save as signed out, not as signed in to nothing', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getAgentBrowserPreset).mockResolvedValue(
      preset({ saved: false, sites: [] })
    );
    renderCard(transport);
    expect(await screen.findByText(/starts signed out/)).toBeInTheDocument();
    expect(screen.queryByText(/^Signed in to/)).not.toBeInTheDocument();
  });
});
