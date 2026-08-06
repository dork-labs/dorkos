// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/layers/entities/runtime', () => ({
  useCapabilitiesForRuntime: vi.fn(() => ({ supportsManagedMcpServers: true })),
}));

// The section's inbound-direction cross-link uses useSettingsDeepLink's open(),
// which needs TanStack Router context. Mock it to a plain spy — everything else
// in the shared/model barrel (TransportProvider below) stays real.
const { openSettingsSpy } = vi.hoisted(() => ({ openSettingsSpy: vi.fn() }));
vi.mock('@/layers/shared/model', async () => {
  const actual =
    await vi.importActual<typeof import('@/layers/shared/model')>('@/layers/shared/model');
  return { ...actual, useSettingsDeepLink: () => ({ open: openSettingsSpy }) };
});

import { AgentMcpServers } from '../ui/AgentMcpServers';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport, CapabilityApprovalRequired } from '@dorkos/shared/transport';
import type { AgentManifest, ManagedMcpServer } from '@dorkos/shared/mesh-schemas';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

const agent: AgentManifest = {
  id: '01HZ0000000000000000000001',
  name: 'test-agent',
  displayName: 'Test Agent',
  description: '',
  runtime: 'claude-code',
  capabilities: [],
  behavior: { responseMode: 'always' },
  registeredAt: '2025-01-01T00:00:00.000Z',
  registeredBy: 'test',
  personaEnabled: true,
  enabledToolGroups: {},
  mcpServers: [],
};

const managedServer: ManagedMcpServer = {
  name: 'filesystem',
  enabled: true,
  connection: { transport: 'stdio', command: 'npx', args: [], env: {} },
  addedAt: '2026-01-01T00:00:00.000Z',
  addedBy: 'operator',
};

const oauthServer: ManagedMcpServer = {
  name: 'granola',
  enabled: true,
  connection: {
    transport: 'http',
    url: 'https://mcp.granola.ai/mcp',
    headers: {},
    authKind: 'oauth2',
  },
  addedAt: '2026-01-01T00:00:00.000Z',
  addedBy: 'operator',
};

function renderComponent(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return render(<AgentMcpServers agent={agent} projectPath="/projects/test" />, { wrapper });
}

describe('AgentMcpServers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openSettingsSpy.mockClear();
    vi.mocked(useCapabilitiesForRuntime).mockReturnValue({
      supportsManagedMcpServers: true,
    } as RuntimeCapabilities);
  });

  it('cross-links to Settings → Tools for the inbound MCP direction (plan D7)', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([]),
      getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() =>
      expect(within(container).getByText(/other apps to use dorkos as an mcp server/i))
    );
    fireEvent.click(within(container).getByRole('button', { name: /see settings.*tools/i }));
    expect(openSettingsSpy).toHaveBeenCalledWith('tools', 'external-mcp');
  });

  it('renders a managed row joined with live status by name', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([managedServer]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'filesystem', type: 'stdio', status: 'connected' }],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(container.querySelector('.bg-green-500')).not.toBeNull());
    expect(within(container).getByText('filesystem')).toBeInTheDocument();
    // The enable switch and Test control are present for a managed (editable) row.
    expect(within(container).getByLabelText('Enable filesystem')).toBeInTheDocument();
    expect(within(container).getByRole('button', { name: 'Test' })).toBeInTheDocument();
  });

  it('shows a discovered (read-only) row for a live server with no managed match', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'legacy', type: 'http', status: 'connected' }],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('legacy')).toBeInTheDocument());
    expect(within(container).getByText('discovered')).toBeInTheDocument();
    // Discovered servers are not editable — no enable switch.
    expect(within(container).queryByLabelText('Enable legacy')).not.toBeInTheDocument();
  });

  it('renders the empty state when there are no managed or discovered servers', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([]),
      getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() =>
      expect(within(container).getByText(/No MCP servers yet/i)).toBeInTheDocument()
    );
  });

  it('renders an error state with a retry when the list fails', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockRejectedValue(new Error('boom')),
      getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() =>
      expect(within(container).getByText(/Couldn.t load managed servers/i)).toBeInTheDocument()
    );
    expect(within(container).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('disables Add and explains when the runtime cannot run managed servers (OpenCode)', async () => {
    vi.mocked(useCapabilitiesForRuntime).mockReturnValue({
      supportsManagedMcpServers: false,
    } as RuntimeCapabilities);
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([]),
      getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() =>
      expect(
        within(container).getByText(/can.t run DorkOS-managed MCP servers yet/i)
      ).toBeInTheDocument()
    );
    expect(
      within(container).queryByRole('button', { name: /add server/i })
    ).not.toBeInTheDocument();
  });

  it('enables Add for a Codex agent (supportsManagedMcpServers is the gate, not supportsMcp)', async () => {
    // Codex is the DOR-892 case: it hosts no in-process DorkOS tool server
    // (`supportsMcp: false`) but DOES accept injected managed servers. The Add
    // affordance must key on `supportsManagedMcpServers`, so a false `supportsMcp`
    // here must not gate it off.
    vi.mocked(useCapabilitiesForRuntime).mockReturnValue({
      supportsMcp: false,
      supportsManagedMcpServers: true,
    } as RuntimeCapabilities);
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([]),
      getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() =>
      expect(within(container).getByRole('button', { name: /add server/i })).toBeInTheDocument()
    );
    expect(
      within(container).queryByText(/can.t run DorkOS-managed MCP servers yet/i)
    ).not.toBeInTheDocument();
  });

  it('offers Manage on a discovered row for a managed-capable runtime', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'legacy', type: 'stdio', status: 'connected' }],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() =>
      expect(within(container).getByRole('button', { name: 'Manage legacy' })).toBeInTheDocument()
    );
  });

  it('hides Manage on a discovered row when the runtime cannot manage servers', async () => {
    vi.mocked(useCapabilitiesForRuntime).mockReturnValue({
      supportsManagedMcpServers: false,
    } as RuntimeCapabilities);
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'legacy', type: 'stdio', status: 'connected' }],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('legacy')).toBeInTheDocument());
    expect(
      within(container).queryByRole('button', { name: 'Manage legacy' })
    ).not.toBeInTheDocument();
  });

  it('imports a discovered server: Manage → approval → confirm → grant → retry → managed', async () => {
    const approval: CapabilityApprovalRequired = {
      status: 'approval_required',
      capabilityId: 'mcp.import',
      capabilityTitle: 'Import a discovered MCP server into DorkOS management',
      tier: 'destructive',
      approvalId: 'appr-2',
      approvalToken: 'tok-2',
      expiresAt: '2026-01-01T00:10:00.000Z',
      reason: 'destructive_tier',
      message: 'Approve to manage the server.',
      retry: {
        channel: 'http-header',
        field: 'X-DorkOS-Approval',
        instructions: 'retry with token',
      },
    };
    const importAgentMcpServer = vi
      .fn()
      .mockResolvedValueOnce({ status: 'approval_required', approval })
      .mockResolvedValueOnce({ status: 'ok', servers: [managedServer] });
    const grantApproval = vi
      .fn()
      .mockResolvedValue({ ok: true, approvalId: 'appr-2', outcome: 'granted' });
    // The list is empty first, then reports the imported server after invalidation.
    const listAgentMcpServers = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([managedServer]);
    const getMcpConfig = vi.fn().mockResolvedValue({
      servers: [{ name: 'filesystem', type: 'stdio', status: 'connected' }],
    });
    const transport = createMockTransport({
      listAgentMcpServers,
      getMcpConfig,
      importAgentMcpServer,
      grantApproval,
    });
    const { container } = renderComponent(transport);

    await waitFor(() =>
      expect(
        within(container).getByRole('button', { name: 'Manage filesystem' })
      ).toBeInTheDocument()
    );
    fireEvent.click(within(container).getByRole('button', { name: 'Manage filesystem' }));

    // The confirm surface names the server being brought under management.
    await waitFor(() =>
      expect(
        within(container).getByText(/Manage .*filesystem.* for Test Agent/i)
      ).toBeInTheDocument()
    );
    fireEvent.click(within(container).getByRole('button', { name: /confirm & manage/i }));

    await waitFor(() => expect(grantApproval).toHaveBeenCalledWith('appr-2'));
    expect(importAgentMcpServer).toHaveBeenCalledTimes(2);
    // First call has no token; the confirming retry carries it.
    expect(importAgentMcpServer.mock.calls[0][1]).toBeUndefined();
    expect(importAgentMcpServer.mock.calls[1][1]).toEqual({ approvalToken: 'tok-2' });
    expect(importAgentMcpServer.mock.calls[0][0]).toEqual({
      agentId: agent.id,
      name: 'filesystem',
    });

    // The row transitions discovered → managed: the managed (editable) row now
    // shows its enable switch, which a discovered row never has.
    await waitFor(() =>
      expect(within(container).getByLabelText('Enable filesystem')).toBeInTheDocument()
    );
  });

  it('adds a server through the confirm step: approval → grant → retry → success', async () => {
    const approval: CapabilityApprovalRequired = {
      status: 'approval_required',
      capabilityId: 'mcp.add',
      capabilityTitle: 'Add a managed MCP server',
      tier: 'destructive',
      approvalId: 'appr-1',
      approvalToken: 'tok-1',
      expiresAt: '2026-01-01T00:10:00.000Z',
      reason: 'destructive_tier',
      message: 'Approve to add the server.',
      retry: {
        channel: 'http-header',
        field: 'X-DorkOS-Approval',
        instructions: 'retry with token',
      },
    };
    const addAgentMcpServer = vi
      .fn()
      .mockResolvedValueOnce({ status: 'approval_required', approval })
      .mockResolvedValueOnce({ status: 'ok', servers: [managedServer] });
    const grantApproval = vi
      .fn()
      .mockResolvedValue({ ok: true, approvalId: 'appr-1', outcome: 'granted' });
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([]),
      getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
      addAgentMcpServer,
      grantApproval,
    });
    const { container } = renderComponent(transport);

    await waitFor(() =>
      expect(within(container).getByRole('button', { name: /add server/i })).toBeInTheDocument()
    );
    fireEvent.click(within(container).getByRole('button', { name: /add server/i }));

    fireEvent.change(within(container).getByLabelText('Name'), { target: { value: 'filesystem' } });
    fireEvent.change(within(container).getByLabelText('Command'), { target: { value: 'npx' } });
    fireEvent.click(within(container).getByRole('button', { name: 'Continue' }));

    // The confirm surface shows the exact command the operator entered.
    await waitFor(() =>
      expect(within(container).getByText(/Confirm this server for Test Agent/i)).toBeInTheDocument()
    );
    expect(within(container).getByText('npx')).toBeInTheDocument();

    fireEvent.click(within(container).getByRole('button', { name: /confirm & add/i }));

    await waitFor(() => expect(grantApproval).toHaveBeenCalledWith('appr-1'));
    expect(addAgentMcpServer).toHaveBeenCalledTimes(2);
    // First call has no token; the confirming retry carries it.
    expect(addAgentMcpServer.mock.calls[0][1]).toBeUndefined();
    expect(addAgentMcpServer.mock.calls[1][1]).toEqual({ approvalToken: 'tok-1' });
    expect(addAgentMcpServer.mock.calls[1][0]).toMatchObject({
      agentId: agent.id,
      name: 'filesystem',
      connection: { transport: 'stdio', command: 'npx' },
    });
  });

  it('labels the live status legibly instead of a bare, aria-hidden color dot', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([oauthServer]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'granola', type: 'http', status: 'needs-auth' }],
      }),
    });
    const { container } = renderComponent(transport);

    // The status carries an accessible name a screen reader reaches, and the
    // label is visible text — not the old color-only dot.
    await waitFor(() =>
      expect(container.querySelector('[aria-label="Status: Needs sign-in"]')).not.toBeNull()
    );
    expect(within(container).getByText('Needs sign-in')).toBeVisible();
  });

  it('shows a Sign in button only when the server needs OAuth sign-in', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([oauthServer]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'granola', type: 'http', status: 'needs-auth' }],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() =>
      expect(within(container).getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    );
  });

  it('hides the Sign in button when the server is connected', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([oauthServer]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'granola', type: 'http', status: 'connected' }],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('granola')).toBeInTheDocument());
    expect(within(container).queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('renders a friendly sign-in nudge, not the raw 401, when Test reports needsAuth', async () => {
    const rawError =
      'Streamable HTTP error: POST https://mcp.granola.ai/mcp {"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized"}}';
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([oauthServer]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'granola', type: 'http', status: 'needs-auth' }],
      }),
      testAgentMcpServer: vi
        .fn()
        .mockResolvedValue({ ok: false, needsAuth: true, error: rawError }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('granola')).toBeInTheDocument());
    fireEvent.click(within(container).getByRole('button', { name: 'Test' }));

    await waitFor(() =>
      expect(within(container).getByText('Needs sign-in — click Sign in.')).toBeInTheDocument()
    );
    // The raw "Unauthorized" string never reaches the user.
    expect(within(container).queryByText(/Unauthorized/)).not.toBeInTheDocument();
  });

  it('drives the sign-in flow: Sign in → disclosure-before-link → open → connected', async () => {
    const startMcpSignin = vi.fn().mockResolvedValue({
      flowId: 'flow-1',
      authorizeUrl: 'https://auth.example/authorize?x=1',
      alreadyConnected: false,
      disclosure: 'DorkOS keeps the resulting token encrypted on this computer.',
      message: 'sign-in link',
    });
    // The poll (fired when the flow enters waiting) reports connected at once.
    const pollMcpSignin = vi.fn().mockResolvedValue({ status: 'connected' });
    // Live status starts needs-auth, then reads connected after invalidation.
    const getMcpConfig = vi
      .fn()
      .mockResolvedValueOnce({ servers: [{ name: 'granola', type: 'http', status: 'needs-auth' }] })
      .mockResolvedValue({ servers: [{ name: 'granola', type: 'http', status: 'connected' }] });
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([oauthServer]),
      getMcpConfig,
      startMcpSignin,
      pollMcpSignin,
    });
    const { container } = renderComponent(transport);

    await waitFor(() =>
      expect(within(container).getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    );
    fireEvent.click(within(container).getByRole('button', { name: 'Sign in' }));

    // Disclosure-before-URL: the custody sentence shows, and the link exists but
    // has not been followed — no poll yet.
    await waitFor(() =>
      expect(
        within(container).getByText(/DorkOS keeps the resulting token encrypted/i)
      ).toBeInTheDocument()
    );
    expect(startMcpSignin).toHaveBeenCalledWith(agent.id, 'granola');
    expect(pollMcpSignin).not.toHaveBeenCalled();
    const link = within(container).getByRole('link', {
      name: /Open the sign-in page for granola/i,
    });
    expect(link).toHaveAttribute('href', 'https://auth.example/authorize?x=1');

    // Open the link → waiting → poll connected → success copy.
    fireEvent.click(link);
    await waitFor(() =>
      expect(
        within(container).getByText(/Signed in — the server’s tools are available/i)
      ).toBeInTheDocument()
    );
    expect(pollMcpSignin).toHaveBeenCalledWith('flow-1');
  });
});
