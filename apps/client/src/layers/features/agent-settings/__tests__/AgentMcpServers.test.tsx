// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, fireEvent, waitFor, within, act } from '@testing-library/react';
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
import type {
  AgentManifest,
  ManagedMcpServer,
  ManagedMcpServerView,
} from '@dorkos/shared/mesh-schemas';
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

// Radix Select drives itself with pointer capture and scrolls the highlighted
// option into view — browser APIs jsdom does not implement, and without them the
// Add form's transport listbox never opens.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

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
  return {
    ...render(<AgentMcpServers agent={agent} projectPath="/projects/test" />, { wrapper }),
    queryClient,
  };
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

    // The status is legible text a screen reader reaches — not the old, label-less
    // color dot. jest-dom's toBeVisible treats an aria-hidden node as not visible,
    // so this reddens if the chip regresses to a bare aria-hidden dot.
    await waitFor(() => expect(within(container).getByText('Needs sign-in')).toBeVisible());
  });

  it('shows Disabled (and no Sign in) for a disabled server even when live status is needs-auth', async () => {
    // The `enabled ? live?.status : 'disabled'` fold must win: a turned-off server
    // is Disabled and offers no sign-in, whatever its last live status was.
    const disabledServer: ManagedMcpServer = { ...oauthServer, enabled: false };
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([disabledServer]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'granola', type: 'http', status: 'needs-auth' }],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('granola')).toBeInTheDocument());
    expect(within(container).getByText('Disabled')).toBeInTheDocument();
    expect(within(container).queryByText('Needs sign-in')).not.toBeInTheDocument();
    expect(within(container).queryByRole('button', { name: /^Sign in/ })).not.toBeInTheDocument();
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
      expect(within(container).getByRole('button', { name: /^Sign in/ })).toBeInTheDocument()
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
    expect(within(container).queryByRole('button', { name: /^Sign in/ })).not.toBeInTheDocument();
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

  it('offers Sign in when Test just said needs-auth and no runtime status exists (DOR-985)', async () => {
    // The reported bug, exactly: a fresh server process has written no MCP status
    // cache, so the row has no live status at all. Test answers "Needs sign-in —
    // click Sign in" and, before this fix, there was no such button to click.
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([{ ...oauthServer, authStatus: undefined }]),
      getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
      testAgentMcpServer: vi.fn().mockResolvedValue({ ok: false, needsAuth: true, error: 'raw' }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('granola')).toBeInTheDocument());
    // Precondition: with no status and no probe yet, there is nothing to sign in from.
    expect(within(container).queryByRole('button', { name: /^Sign in/ })).not.toBeInTheDocument();

    fireEvent.click(within(container).getByRole('button', { name: 'Test' }));

    await waitFor(() =>
      expect(within(container).getByRole('button', { name: /^Sign in/ })).toBeInTheDocument()
    );
  });

  it('reads needs-auth off the listing when the runtime has reported nothing yet', async () => {
    const needsAuth: ManagedMcpServerView = { ...oauthServer, authStatus: 'needs-auth' };
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([needsAuth]),
      getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
    });
    const { container } = renderComponent(transport);

    // Without the derived authStatus this row reads "Unknown" with no button —
    // which is what the runtime cache alone can say before the first turn.
    await waitFor(() => expect(within(container).getByText('Needs sign-in')).toBeInTheDocument());
    expect(within(container).getByRole('button', { name: /^Sign in/ })).toBeInTheDocument();
    expect(within(container).queryByText('Unknown')).not.toBeInTheDocument();
  });

  it('lets a live token override a stale runtime needs-auth', async () => {
    const connected: ManagedMcpServerView = { ...oauthServer, authStatus: 'connected' };
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([connected]),
      // The runtime's cache was written on an earlier turn, before the sign-in.
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'granola', type: 'http', status: 'needs-auth' }],
      }),
    });
    const { container } = renderComponent(transport);

    // "Signed in", not "Connected": DorkOS holds a token, but the only thing that
    // ever reached this server said needs-auth, so claiming a live connection
    // would overstate what is known.
    await waitFor(() => expect(within(container).getByText('Signed in')).toBeInTheDocument());
    expect(within(container).queryByText('Needs sign-in')).not.toBeInTheDocument();
    expect(within(container).queryByRole('button', { name: /^Sign in/ })).not.toBeInTheDocument();
  });

  it('lets a missing token override a stale runtime connected (the symmetric half)', async () => {
    // The expiry path: signed in, one turn ran (runtime cached "connected"), then
    // the token expired and its refresh failed, so the cache evicted it. Reading
    // the runtime alone leaves a green chip on a server whose next turn provably
    // carries no bearer — DOR-985 again, from the other side.
    const stale: ManagedMcpServerView = { ...oauthServer, authStatus: 'needs-auth' };
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([stale]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'granola', type: 'http', status: 'connected' }],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('Needs sign-in')).toBeInTheDocument());
    expect(within(container).queryByText('Connected')).not.toBeInTheDocument();
    expect(within(container).getByRole('button', { name: /^Sign in/ })).toBeInTheDocument();
  });

  it('offers Sign in when Test says needs-auth even while the runtime still says connected', async () => {
    // Belt to the braces above: whatever the caches say, Test is the only thing
    // here that actually contacted the server. Its 401 must reach the person as a
    // button, not just as a sentence telling them to press one that is not there.
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([{ ...oauthServer, authStatus: undefined }]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'granola', type: 'http', status: 'connected' }],
      }),
      testAgentMcpServer: vi.fn().mockResolvedValue({ ok: false, needsAuth: true, error: 'raw' }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('Connected')).toBeInTheDocument());
    expect(within(container).queryByRole('button', { name: /^Sign in/ })).not.toBeInTheDocument();

    fireEvent.click(within(container).getByRole('button', { name: 'Test' }));

    await waitFor(() =>
      expect(within(container).getByRole('button', { name: /^Sign in/ })).toBeInTheDocument()
    );
  });

  it('promotes the chip to Connected when Test dials through (DOR-985 P3)', async () => {
    // Test is the only thing on this row that actually contacted the server, and
    // since DOR-985 it dials WITH the bearer. An `ok` is therefore a round trip
    // that provably worked — stronger evidence than any cache, including the
    // amber "Needs sign-in" the row was showing a moment earlier.
    const transport = createMockTransport({
      listAgentMcpServers: vi
        .fn()
        .mockResolvedValue([{ ...oauthServer, authStatus: 'needs-auth' } as ManagedMcpServerView]),
      getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
      testAgentMcpServer: vi.fn().mockResolvedValue({ ok: true, toolCount: 4 }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('Needs sign-in')).toBeInTheDocument());

    fireEvent.click(within(container).getByRole('button', { name: 'Test' }));

    await waitFor(() => expect(within(container).getByText('Connected')).toBeInTheDocument());
    expect(within(container).queryByText('Needs sign-in')).not.toBeInTheDocument();
  });

  it('drops a stale OK probe once the listing says the token is gone (DOR-985 P3)', async () => {
    // The probe pinned the chip green for the life of the panel. Lose the token
    // while it is open — expiry, a revoke, a refresh that failed — and the row
    // kept claiming Connected off a probe that had been overtaken, with no Sign in
    // button: exactly the lie DOR-985 existed to kill, re-introduced by its own
    // fix. A probe is evidence about one moment; a newer listing outranks it.
    const listing = vi
      .fn()
      .mockResolvedValueOnce([{ ...oauthServer, authStatus: 'connected' } as ManagedMcpServerView])
      .mockResolvedValue([{ ...oauthServer, authStatus: 'needs-auth' } as ManagedMcpServerView]);
    const transport = createMockTransport({
      listAgentMcpServers: listing,
      getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
      testAgentMcpServer: vi.fn().mockResolvedValue({ ok: true, toolCount: 4 }),
    });
    const { container, queryClient } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('Signed in')).toBeInTheDocument());
    fireEvent.click(within(container).getByRole('button', { name: 'Test' }));

    // A fresh OK probe still beats the listing at the moment it lands — that is
    // the shipped behavior, and it stays.
    await waitFor(() => expect(within(container).getByText('Connected')).toBeInTheDocument());

    // …then the roster re-reads and reports the token gone. In real life the
    // sign-in flow's own invalidation triggers this; here it is explicit.
    await act(async () => {
      await queryClient.invalidateQueries();
    });

    await waitFor(() => expect(within(container).getByText('Needs sign-in')).toBeInTheDocument());
    expect(within(container).queryByText('Connected')).not.toBeInTheDocument();
    expect(within(container).getByRole('button', { name: /^Sign in/ })).toBeInTheDocument();
  });

  it('lets a missing token override a stale runtime PENDING too (DOR-985 P3)', async () => {
    // The same lie as a stale `connected`, told more quietly: a cached
    // "Connecting…" from a past turn outranking the live, provable fact that
    // there is no token left the row spinning with nothing to press.
    const stale: ManagedMcpServerView = { ...oauthServer, authStatus: 'needs-auth' };
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([stale]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'granola', type: 'http', status: 'pending' }],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('Needs sign-in')).toBeInTheDocument());
    expect(within(container).queryByText('Connecting…')).not.toBeInTheDocument();
    expect(within(container).getByRole('button', { name: /^Sign in/ })).toBeInTheDocument();
  });

  it('still shows Failed when the runtime failed, even with a live token', async () => {
    const connected: ManagedMcpServerView = { ...oauthServer, authStatus: 'connected' };
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([connected]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'granola', type: 'http', status: 'failed' }],
      }),
    });
    const { container } = renderComponent(transport);

    // The override is narrow on purpose: holding a token says nothing about
    // whether the server answered. Widening it to beat every runtime status
    // would hide a real failure behind a green chip.
    await waitFor(() => expect(within(container).getByText('Failed')).toBeInTheDocument());
  });

  it('flips the chip to Signed in the moment the sign-in lands, without waiting for the runtime', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi
        .fn()
        .mockResolvedValue([{ ...oauthServer, authStatus: 'needs-auth' }]),
      // The runtime keeps saying needs-auth for the whole test — its cache is
      // only rewritten on the next turn.
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'granola', type: 'http', status: 'needs-auth' }],
      }),
      startMcpSignin: vi.fn().mockResolvedValue({
        flowId: 'flow-1',
        authorizeUrl: 'https://auth.example/authorize?x=1',
        alreadyConnected: false,
        disclosure: 'DorkOS keeps the resulting token encrypted on this computer.',
        message: 'sign-in link',
      }),
      pollMcpSignin: vi.fn().mockResolvedValue({ status: 'connected' }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() =>
      expect(within(container).getByRole('button', { name: /^Sign in/ })).toBeInTheDocument()
    );
    fireEvent.click(within(container).getByRole('button', { name: /^Sign in/ }));
    const link = await waitFor(() =>
      within(container).getByRole('link', { name: /Open the sign-in page for granola/i })
    );
    fireEvent.click(link);

    await waitFor(() => expect(within(container).getByText('Signed in')).toBeInTheDocument());
    expect(within(container).queryByText('Needs sign-in')).not.toBeInTheDocument();
    expect(within(container).queryByRole('button', { name: /^Sign in/ })).not.toBeInTheDocument();
  });

  it('probes a newly added remote server on its own, so the sign-in nudge appears unasked', async () => {
    const testAgentMcpServer = vi
      .fn()
      .mockResolvedValue({ ok: false, needsAuth: true, error: 'raw 401' });
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([]),
      getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
      addAgentMcpServer: vi.fn().mockResolvedValue({ status: 'ok', servers: [oauthServer] }),
      testAgentMcpServer,
    });
    const { container } = renderComponent(transport);

    await waitFor(() =>
      expect(within(container).getByRole('button', { name: /add server/i })).toBeInTheDocument()
    );
    fireEvent.click(within(container).getByRole('button', { name: /add server/i }));
    fireEvent.change(within(container).getByLabelText('Name'), { target: { value: 'granola' } });
    // Switch the transport to http — a stdio server has no sign-in to probe for.
    fireEvent.keyDown(within(container).getByRole('combobox'), { key: 'Enter' });
    fireEvent.click(within(document.body).getByRole('option', { name: 'http' }));
    fireEvent.change(within(container).getByLabelText('URL'), {
      target: { value: 'https://mcp.granola.ai/mcp' },
    });
    fireEvent.click(within(container).getByRole('button', { name: 'Continue' }));

    // No approval came back, so the write landed and the roster follows up.
    await waitFor(() => expect(testAgentMcpServer).toHaveBeenCalledWith(agent.id, 'granola'));
  });

  it('does NOT probe a newly added stdio server (no sign-in exists for a local command)', async () => {
    const testAgentMcpServer = vi.fn().mockResolvedValue({ ok: true, toolCount: 1 });
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([]),
      getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
      addAgentMcpServer: vi.fn().mockResolvedValue({ status: 'ok', servers: [managedServer] }),
      testAgentMcpServer,
    });
    const { container } = renderComponent(transport);

    await waitFor(() =>
      expect(within(container).getByRole('button', { name: /add server/i })).toBeInTheDocument()
    );
    fireEvent.click(within(container).getByRole('button', { name: /add server/i }));
    fireEvent.change(within(container).getByLabelText('Name'), { target: { value: 'filesystem' } });
    fireEvent.change(within(container).getByLabelText('Command'), { target: { value: 'npx' } });
    fireEvent.click(within(container).getByRole('button', { name: 'Continue' }));

    // The add resolved, so the callback ran — and chose not to probe.
    await waitFor(() =>
      expect(within(container).getByRole('button', { name: /add server/i })).toBeInTheDocument()
    );
    expect(testAgentMcpServer).not.toHaveBeenCalled();
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
      expect(within(container).getByRole('button', { name: /^Sign in/ })).toBeInTheDocument()
    );
    fireEvent.click(within(container).getByRole('button', { name: /^Sign in/ }));

    // Disclosure-before-URL: the custody sentence shows, and the link exists but
    // has not been followed — no poll yet.
    const disclosure = await waitFor(() =>
      within(container).getByText(/DorkOS keeps the resulting token encrypted/i)
    );
    expect(startMcpSignin).toHaveBeenCalledWith(agent.id, 'granola');
    expect(pollMcpSignin).not.toHaveBeenCalled();
    const link = within(container).getByRole('link', {
      name: /Open the sign-in page for granola/i,
    });
    expect(link).toHaveAttribute('href', 'https://auth.example/authorize?x=1');
    // Consent ORDER, not mere co-presence: the custody sentence must precede the
    // link in the document, so a person reads what happens to their token before
    // the button that starts it. Swapping the two in the panel reddens this;
    // asserting both are present would not.
    expect(disclosure.compareDocumentPosition(link)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // And focus is on the disclosure, not lost to the body, now that the button
    // the person pressed has unmounted.
    expect(disclosure).toHaveFocus();

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
