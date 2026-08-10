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
import type {
  Transport,
  CapabilityApprovalRequired,
  McpServerEntry,
} from '@dorkos/shared/transport';
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

/**
 * Open a card's "⋯" menu and return its Test item.
 *
 * Test is the card's primary action only in the states that lead with it; in
 * every other state it lives in the overflow, which is the point of the redesign
 * (one primary action per state). Radix needs the full pointer sequence to open
 * in jsdom, and the menu portals to the body — hence `document.body`, not the
 * render container.
 */
async function openTestAction(container: HTMLElement, serverName: string): Promise<HTMLElement> {
  const trigger = within(container).getByRole('button', {
    name: `More actions for ${serverName}`,
  });
  await act(async () => {
    fireEvent.pointerDown(trigger);
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
  });
  return await waitFor(() => within(document.body).getByRole('menuitem', { name: 'Test' }));
}

/** Press Test wherever it currently lives: on the card, or behind the "⋯" menu. */
async function pressTest(container: HTMLElement, serverName: string): Promise<void> {
  const onCard = within(container).queryByRole('button', { name: 'Test' });
  if (onCard) {
    fireEvent.click(onCard);
    return;
  }
  const item = await openTestAction(container, serverName);
  await act(async () => {
    fireEvent.click(item);
  });
}

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

    // The join is what makes the card say Connected at all: without the live
    // status the card has nothing to read and says "Not checked yet".
    await waitFor(() => expect(within(container).getByText('Connected')).toBeInTheDocument());
    expect(within(container).getByText('filesystem')).toBeInTheDocument();
    // The enable switch and the Test control are both present for a managed
    // (editable) card — Test behind the "⋯" menu, since a connected server leads
    // with no action of its own.
    expect(within(container).getByLabelText('Enable filesystem')).toBeInTheDocument();
    expect(await openTestAction(container, 'filesystem')).toBeInTheDocument();
  });

  it('shows a card for a live server with no managed match, and claims no origin it cannot prove', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'legacy', type: 'http', status: 'connected' }],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('legacy')).toBeInTheDocument());
    // The old "discovered" badge named DorkOS's own bookkeeping and is gone. What
    // replaces it is a word about where the server came from — and this entry
    // carries NO scope, so there is no such word to show. It briefly defaulted to
    // "computer", which told people a server might well be their project's own
    // came from their computer-wide config.
    expect(within(container).queryByText('discovered')).not.toBeInTheDocument();
    expect(within(container).queryByText('computer')).not.toBeInTheDocument();
    expect(within(container).queryByText('project')).not.toBeInTheDocument();
    expect(
      within(container).getByText(
        'This agent’s runtime loads this server. Add it to manage it here.'
      )
    ).toBeInTheDocument();
    // Servers DorkOS does not manage are not editable — no enable switch.
    expect(within(container).queryByLabelText('Enable legacy')).not.toBeInTheDocument();
  });

  it('badges a user-scoped server as coming from your computer', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'granola-notes', type: 'stdio', status: 'connected', scope: 'user' }],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('computer')).toBeInTheDocument());
    expect(
      within(container).getByText(/From your computer-wide config\. Add it to manage it here\./)
    ).toBeInTheDocument();
  });

  it('badges a project-scoped server as coming from this project', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'shadcn', type: 'stdio', status: 'connected', scope: 'project' }],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('project')).toBeInTheDocument());
    expect(
      within(container).getByText(/From this project’s config\. Add it to manage it here\./)
    ).toBeInTheDocument();
  });

  it('parses a plugin-qualified name: clean name on the card, plugin badge, raw id in Details', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'plugin:context7', type: 'stdio', status: 'connected' }],
      }),
    });
    const { container } = renderComponent(transport);

    // The card shows the clean name, never the raw `plugin:context7` that used
    // to truncate to "plugin:cont…".
    await waitFor(() => expect(within(container).getByText('context7')).toBeInTheDocument());
    expect(within(container).getByText('plugin')).toBeInTheDocument();
    expect(within(container).queryByText('plugin:context7')).not.toBeInTheDocument();

    // …and the raw id is still reachable, because a person debugging needs the
    // string the runtime actually used.
    fireEvent.click(within(container).getByRole('button', { name: 'Details' }));
    expect(within(container).getByText('plugin:context7')).toBeInTheDocument();
  });

  it('shows an unrecognised name exactly as the runtime gave it (the parser falls through)', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'my-server', type: 'stdio', status: 'connected' }],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('my-server')).toBeInTheDocument());
    // No plugin badge and no second name to disclose — there was nothing to parse,
    // so nothing was renamed.
    expect(within(container).queryByText('plugin')).not.toBeInTheDocument();
    expect(within(container).queryByText('Raw id')).not.toBeInTheDocument();
  });

  it('offers no Details at all on a card that would have nothing to put in them', async () => {
    // The exact shape the honest-scope fix creates, and the shape of EVERY card
    // from a runtime that reports no scope (OpenCode): no scope, no plugin, an
    // unparsed name, no error. A card DorkOS does not manage has no connection to
    // describe either, so all three possible rows are absent — and the affordance
    // used to expand into an empty bordered box with a Collapse control under it.
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'my-server', type: 'stdio', status: 'connected' }],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('my-server')).toBeInTheDocument());
    expect(within(container).queryByRole('button', { name: 'Details' })).not.toBeInTheDocument();
  });

  it('still offers Details when there IS something to show — a scope, or an error', async () => {
    // The other half, so the fix above cannot be satisfied by dropping Details
    // everywhere: a card with any one row keeps the affordance.
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [
          { name: 'scoped', type: 'stdio', status: 'connected', scope: 'project' },
          { name: 'broken', type: 'stdio', status: 'failed', error: 'ECONNREFUSED' },
        ],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('scoped')).toBeInTheDocument());
    expect(within(container).getAllByRole('button', { name: 'Details' })).toHaveLength(2);
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

  it('offers Add to agent on an unmanaged card for a managed-capable runtime', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'legacy', type: 'stdio', status: 'connected' }],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() =>
      expect(
        within(container).getByRole('button', { name: 'Add legacy to agent' })
      ).toBeInTheDocument()
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
      within(container).queryByRole('button', { name: 'Add legacy to agent' })
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
        within(container).getByRole('button', { name: 'Add filesystem to agent' })
      ).toBeInTheDocument()
    );
    fireEvent.click(within(container).getByRole('button', { name: 'Add filesystem to agent' }));

    // The confirm surface names the server and the agent, and says what the
    // person gets — not what DorkOS's bookkeeping does.
    await waitFor(() =>
      expect(within(container).getByText(/Add .*filesystem.* to Test Agent\?/i)).toBeInTheDocument()
    );
    expect(
      within(container).getByText(/Manage it here to enable, disable, or sign in from DorkOS\./i)
    ).toBeInTheDocument();
    expect(within(container).queryByText(/under DorkOS management/i)).not.toBeInTheDocument();
    fireEvent.click(within(container).getByRole('button', { name: /^Add to agent$/ }));

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
    expect(within(container).getByText('Off')).toBeInTheDocument();
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
    await pressTest(container, 'granola');

    await waitFor(() =>
      expect(
        within(container).getByText('Sign in to granola so this agent can use its tools.')
      ).toBeInTheDocument()
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

    await pressTest(container, 'granola');

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

    await pressTest(container, 'granola');

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

    await pressTest(container, 'granola');

    await waitFor(() => expect(within(container).getByText('Connected')).toBeInTheDocument());
    expect(within(container).queryByText('Needs sign-in')).not.toBeInTheDocument();
  });

  it('clears the "click Sign in" line the moment the sign-in lands (user-reported)', async () => {
    // The exact sequence a user hit: press Test, read "Needs sign-in — click Sign
    // in.", sign in successfully… and the line stayed put, telling them to press a
    // button that was no longer there, under a row that had just gone green.
    //
    // The staleness rule was one-sided: it dropped a stale OK probe when the
    // listing later said needs-auth, but never dropped a stale needs-auth probe
    // when the sign-in later succeeded. A probe is a fact about one moment in
    // BOTH directions.
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([oauthServer]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'granola', type: 'http', status: 'needs-auth' }],
      }),
      testAgentMcpServer: vi.fn().mockResolvedValue({ ok: false, needsAuth: true, error: '401' }),
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

    // 1. Test → the nudge appears.
    await waitFor(() => expect(within(container).getByText('Needs sign-in')).toBeInTheDocument());
    await pressTest(container, 'granola');
    await waitFor(() =>
      expect(
        within(container).getByText('Sign in to granola so this agent can use its tools.')
      ).toBeInTheDocument()
    );

    // 2. Sign in, all the way through.
    fireEvent.click(within(container).getByRole('button', { name: /^Sign in/ }));
    const link = await waitFor(() =>
      within(container).getByRole('link', { name: /Open the sign-in page for granola/i })
    );
    fireEvent.click(link);

    // 3. The line is GONE, and the row says so.
    await waitFor(() =>
      expect(
        within(container).queryByText('Sign in to granola so this agent can use its tools.')
      ).not.toBeInTheDocument()
    );
    expect(within(container).getByText('Signed in')).toBeInTheDocument();
    expect(within(container).queryByRole('button', { name: /^Sign in/ })).not.toBeInTheDocument();
  });

  it('clears the nudge when ANOTHER tab is what signed in (user-reported, cross-tab)', async () => {
    // No sign-in flow ran in this row, so `signedInNow` is false throughout. The
    // listing landing later with `connected` is the only thing that can retire the
    // nudge here — and it is also what keeps the line gone after the sign-in panel
    // above is dismissed and `signedInNow` drops back to false.
    const listing = vi
      .fn()
      .mockResolvedValueOnce([{ ...oauthServer, authStatus: 'needs-auth' } as ManagedMcpServerView])
      .mockResolvedValue([{ ...oauthServer, authStatus: 'connected' } as ManagedMcpServerView]);
    const transport = createMockTransport({
      listAgentMcpServers: listing,
      getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
      testAgentMcpServer: vi.fn().mockResolvedValue({ ok: false, needsAuth: true, error: '401' }),
    });
    const { container, queryClient } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('Needs sign-in')).toBeInTheDocument());
    await pressTest(container, 'granola');
    await waitFor(() =>
      expect(
        within(container).getByText('Sign in to granola so this agent can use its tools.')
      ).toBeInTheDocument()
    );

    await act(async () => {
      await queryClient.invalidateQueries();
    });

    await waitFor(() =>
      expect(
        within(container).queryByText('Sign in to granola so this agent can use its tools.')
      ).not.toBeInTheDocument()
    );
    expect(within(container).getByText('Signed in')).toBeInTheDocument();
    // …and the button goes with the line. A row reading "Signed in" beside a Sign
    // in button is the same contradiction from the other side, and `offersSignIn`
    // reads the probe too — so it has to read the SUPERSEDED one, not the raw.
    expect(within(container).queryByRole('button', { name: /^Sign in/ })).not.toBeInTheDocument();
  });

  it('leaves an unreachable-server line alone after a sign-in', async () => {
    // The rule is about AUTH facts. "Couldn't reach this server" is a
    // reachability fact, and signing in does not disprove it — clearing it would
    // hide a real problem behind a green chip.
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([oauthServer]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'granola', type: 'http', status: 'needs-auth' }],
      }),
      testAgentMcpServer: vi.fn().mockResolvedValue({ ok: false, error: 'ECONNREFUSED' }),
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
    await pressTest(container, 'granola');
    await waitFor(() =>
      expect(
        within(container).getByText('This server didn’t answer. It may be down.')
      ).toBeInTheDocument()
    );

    fireEvent.click(within(container).getByRole('button', { name: /^Sign in/ }));
    const link = await waitFor(() =>
      within(container).getByRole('link', { name: /Open the sign-in page for granola/i })
    );
    fireEvent.click(link);

    await waitFor(() => expect(within(container).getByText('Signed in')).toBeInTheDocument());
    expect(
      within(container).getByText('This server didn’t answer. It may be down.')
    ).toBeInTheDocument();
  });

  it('lets the LISTING win a same-millisecond tie with a probe', async () => {
    // At equal stamps "which is newer" is unknowable, so the tie is broken toward
    // the safe answer: believing an overtaken OK probe puts a green chip on a
    // server with no bearer and hides the Sign in button — the DOR-985 lie in a
    // 1ms window. A strict `<` also made the staleness behaviour depend on
    // whether two events landed in the same millisecond, which flaked in a real
    // full-monorepo run.
    //
    // The tie is MANUFACTURED, and manufacturing it means holding one clock for
    // the whole test: `rosterUpdatedAt` is the listing query's `dataUpdatedAt`
    // (`Date.now()` when it landed) and the probe's stamp is `Date.now()` when it
    // settled, so a frozen `Date.now` makes those two equal by construction, with
    // no window to miss.
    //
    // Reading the freeze point back off the query cache instead — the MAX
    // `dataUpdatedAt` across every query — is what made this flake on CI
    // (DOR-1060). This panel runs two independent requests, the listing and the
    // config, and nothing orders them. Land them in one millisecond and the max IS
    // the listing's stamp, so the probe tied and lost; let the config land a
    // millisecond later, as a loaded runner does, and the max sat AHEAD of the
    // listing — so the probe was stamped strictly newer, won the very tie this
    // test is named for, and took the Sign in button below with it.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_760_000_000_000);
    try {
      const transport = createMockTransport({
        listAgentMcpServers: vi
          .fn()
          .mockResolvedValue([
            { ...oauthServer, authStatus: 'needs-auth' } as ManagedMcpServerView,
          ]),
        getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
        testAgentMcpServer: vi.fn().mockResolvedValue({ ok: true, toolCount: 4 }),
      });
      const { container } = renderComponent(transport);

      await waitFor(() => expect(within(container).getByText('Needs sign-in')).toBeInTheDocument());

      await pressTest(container, 'granola');

      // The probe really did run and answer OK — this is not a test that passes
      // because nothing happened. Its answer is then discarded wholesale, so
      // neither its line nor its chip survives: one superseded answer, read by
      // the chip, the button and the line alike.
      await waitFor(() =>
        expect(transport.testAgentMcpServer).toHaveBeenCalledWith(agent.id, 'granola')
      );
      // Wait for the probe to have settled — the card's Sign in button is enabled
      // again — before reading what survived of it.
      await waitFor(() =>
        expect(within(container).getByRole('button', { name: /^Sign in/ })).toBeEnabled()
      );
      expect(within(container).queryByText('4 tools available.')).not.toBeInTheDocument();
      expect(within(container).getByText('Needs sign-in')).toBeInTheDocument();
      expect(within(container).queryByText('Connected')).not.toBeInTheDocument();
      expect(within(container).getByRole('button', { name: /^Sign in/ })).toBeInTheDocument();
    } finally {
      now.mockRestore();
    }
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
    await pressTest(container, 'granola');

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
    await waitFor(() => expect(within(container).getByText('Can’t reach')).toBeInTheDocument());
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
    // ONE custody statement, not two. The trust treatment WRAPS the server's
    // sentence; it was briefly rendered as a second panel above it, which left two
    // stacked paragraphs saying nearly the same thing — the duplicate-disclosure
    // pattern DOR-1004 removed from the agent's prose. The server's sentence
    // appears exactly once, and it appears INSIDE the panel that carries the
    // shield heading.
    expect(
      within(container).getAllByText(/DorkOS keeps the resulting token encrypted/i)
    ).toHaveLength(1);
    const trustHeading = within(container).getByText('Your sign-in stays on this computer.');
    expect(trustHeading.parentElement).toContainElement(disclosure);
    // Consent ORDER, not mere co-presence: the custody sentence must precede the
    // link in the document, so a person reads what happens to their token before
    // the button that starts it. Swapping the two in the panel reddens this;
    // asserting both are present would not.
    expect(disclosure.compareDocumentPosition(link)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // And focus is on the custody panel — not lost to the body, now that the button
    // the person pressed has unmounted. The panel rather than the sentence inside
    // it, so the focus ring outlines the one box being read; the assertion still
    // proves the consent text is what focus landed on.
    expect(document.activeElement).toContainElement(disclosure);
    expect(document.activeElement).not.toBe(document.body);

    // Open the link → waiting → poll connected → success copy.
    fireEvent.click(link);
    await waitFor(() =>
      expect(
        within(container).getByText(/Signed in — the server’s tools are available/i)
      ).toBeInTheDocument()
    );
    expect(pollMcpSignin).toHaveBeenCalledWith('flow-1');
  });

  /** A promise a test resolves by hand, so one query can be made to land last. */
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  /** The names of the cards on screen, top to bottom. */
  function cardOrder(container: HTMLElement): (string | null)[] {
    return [...container.querySelectorAll('[data-mcp-server]')].map((el) =>
      el.getAttribute('data-mcp-server')
    );
  }

  it('waits for the runtime roster before freezing, so a failed server still reaches the top', async () => {
    // The likely race: the manifest is a file read and lands first, the runtime's
    // status goes through the runtime and lands second. Freezing on the manifest
    // alone sorted only the managed servers — and since a runtime FAILURE is
    // knowable only from the second query, no can't-reach card could ever reach
    // the attention band. It was appended after the freeze, below every working
    // card: precisely the card the sort exists to lift.
    const liveConfig = deferred<{ servers: McpServerEntry[] }>();
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([
        { ...managedServer, name: 'healthy' },
        { ...managedServer, name: 'broken' },
      ]),
      getMcpConfig: vi.fn().mockReturnValue(liveConfig.promise),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('healthy')).toBeInTheDocument());

    await act(async () => {
      liveConfig.resolve({
        servers: [
          { name: 'healthy', type: 'stdio', status: 'connected' },
          { name: 'broken', type: 'stdio', status: 'failed', error: 'ECONNREFUSED' },
        ],
      });
    });

    await waitFor(() => expect(within(container).getByText('Can’t reach')).toBeInTheDocument());
    expect(cardOrder(container)).toEqual(['broken', 'healthy']);
  });

  it('waits for the managed listing before freezing, so a managed card is not stranded below', async () => {
    // The same race the other way round. Freezing on the runtime roster alone
    // sorted only the servers DorkOS does not manage, and appended every managed
    // one after them — so a server that needs signing in sat BELOW a working
    // project server it should have led.
    const managedList = deferred<ManagedMcpServerView[]>();
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockReturnValue(managedList.promise),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'shadcn', type: 'stdio', status: 'connected', scope: 'project' }],
      }),
    });
    const { container } = renderComponent(transport);

    // The roster must genuinely LAND, and commit, while the listing is still in
    // flight — otherwise both resolve inside one act(), the component sees a
    // single already-settled commit, and the test passes against a gate that
    // freezes on whichever query arrived first. It would then be a check that
    // cannot fail.
    await waitFor(() => expect(transport.getMcpConfig).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      managedList.resolve([{ ...oauthServer, authStatus: 'needs-auth' } as ManagedMcpServerView]);
    });

    await waitFor(() => expect(within(container).getByText('Needs sign-in')).toBeInTheDocument());
    expect(cardOrder(container)).toEqual(['granola', 'shadcn']);
  });

  it('sorts what needs you to the top when the panel opens, then never moves a card again', async () => {
    // The order is the whole of decision §2.2: sorted once at mount so you can
    // see what needs you, then frozen so a card you are mid-task on cannot
    // teleport. Both halves are asserted, because either alone is satisfiable by
    // doing nothing — never sorting also never moves anything.
    const working: ManagedMcpServerView = {
      ...managedServer,
      name: 'alpha',
      authStatus: undefined,
    };
    const listing = vi
      .fn()
      .mockResolvedValueOnce([
        working,
        { ...oauthServer, name: 'beta', authStatus: 'needs-auth' } as ManagedMcpServerView,
      ])
      // …then beta's token arrives (another tab signed in), so it stops needing you.
      .mockResolvedValue([
        working,
        { ...oauthServer, name: 'beta', authStatus: 'connected' } as ManagedMcpServerView,
      ]);
    const transport = createMockTransport({
      listAgentMcpServers: listing,
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'alpha', type: 'stdio', status: 'connected' }],
      }),
    });
    const { container, queryClient } = renderComponent(transport);

    const order = () =>
      [...container.querySelectorAll('[data-mcp-server]')].map((el) =>
        el.getAttribute('data-mcp-server')
      );

    // Sorted: beta needs you, so it leads — even though the listing puts alpha first.
    await waitFor(() => expect(order()).toEqual(['beta', 'alpha']));

    await act(async () => {
      await queryClient.invalidateQueries();
    });

    // Frozen: beta is no longer in the attention band, and a re-sort would drop it
    // below alpha. It must not move — only its chip changes.
    await waitFor(() => expect(within(container).getByText('Signed in')).toBeInTheDocument());
    expect(order()).toEqual(['beta', 'alpha']);
  });

  it('shows only the Details rows it has data for, and keeps the raw error out of the card face', async () => {
    const rawError = 'Validation failed: missing required field "command"';
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([managedServer]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'filesystem', type: 'stdio', status: 'failed', error: rawError }],
      }),
    });
    const { container } = renderComponent(transport);

    // A validation failure is a setup problem, not an unreachable server — and
    // the verbatim string is nowhere on the card face.
    await waitFor(() => expect(within(container).getByText('Setup problem')).toBeInTheDocument());
    expect(within(container).queryByText(rawError)).not.toBeInTheDocument();

    fireEvent.click(within(container).getByRole('button', { name: 'Details' }));

    // Present: the rows whose data exists today.
    expect(within(container).getByText('Runs `npx` on this computer')).toBeInTheDocument();
    expect(within(container).getByText('None — this server doesn’t need one.')).toBeInTheDocument();
    expect(within(container).getByText(rawError)).toBeInTheDocument();

    // Absent: the rows whose data the API does not carry yet (DOR-1006). They must
    // not render as empty labels — a definition list with blank values reads as
    // broken, not as pending.
    expect(within(container).queryByText('Server')).not.toBeInTheDocument();
    expect(within(container).queryByText('Also used by')).not.toBeInTheDocument();
    expect(within(container).queryByText('Tools')).not.toBeInTheDocument();
  });

  it('offers Sign in again for an OAuth server, and never a Sign out it cannot perform', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi
        .fn()
        .mockResolvedValue([{ ...oauthServer, authStatus: 'connected' } as ManagedMcpServerView]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'granola', type: 'http', status: 'connected' }],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('Connected')).toBeInTheDocument());
    await openTestAction(container, 'granola');

    expect(
      within(document.body).getByRole('menuitem', { name: 'Sign in again' })
    ).toBeInTheDocument();
    // Sign out has no server route yet (spec §7). An item that silently does
    // nothing is worse than an absent one.
    expect(
      within(document.body).queryByRole('menuitem', { name: /sign out/i })
    ).not.toBeInTheDocument();
  });

  it('does not offer Sign in again for a local server there is no sign-in for', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([managedServer]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'filesystem', type: 'stdio', status: 'connected' }],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('Connected')).toBeInTheDocument());
    await openTestAction(container, 'filesystem');

    expect(
      within(document.body).queryByRole('menuitem', { name: 'Sign in again' })
    ).not.toBeInTheDocument();
  });

  it('says "Uses your key" for a server the operator authenticated themselves', async () => {
    const ownKeyServer: ManagedMcpServer = {
      ...oauthServer,
      name: 'internal-api',
      connection: {
        transport: 'http',
        url: 'https://internal.example/mcp',
        headers: { Authorization: 'Bearer operator-supplied' },
      },
    };
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([ownKeyServer]),
      getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
    });
    const { container } = renderComponent(transport);

    // Neither "Not checked yet" (which hides that it IS authenticated) nor
    // "Needs sign-in" (which would put a Sign in button on a server DorkOS holds
    // nothing for).
    await waitFor(() => expect(within(container).getByText('Uses your key')).toBeInTheDocument());
    expect(within(container).queryByRole('button', { name: /^Sign in/ })).not.toBeInTheDocument();
  });

  it('says "Not checked yet", never "Connecting…", for a server nothing has contacted', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([managedServer]),
      getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() => expect(within(container).getByText('Not checked yet')).toBeInTheDocument());
    expect(within(container).queryByText('Connecting…')).not.toBeInTheDocument();
  });
});
