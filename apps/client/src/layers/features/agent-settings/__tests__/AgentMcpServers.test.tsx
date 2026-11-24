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
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import type { Transport, CapabilityApprovalRequired } from '@dorkos/shared/transport';
import type {
  AgentManifest,
  ManagedMcpServer,
  ManagedMcpServerView,
} from '@dorkos/shared/mesh-schemas';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

const agent: AgentManifest = {
  workspace: { mode: 'home' },
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
      within(container).getByText('Loaded from outside DorkOS. Add it to manage it here.')
    ).toBeInTheDocument();
    // Servers DorkOS does not manage are not editable — no enable switch.
    expect(within(container).queryByLabelText('Enable legacy')).not.toBeInTheDocument();
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

  it('renders an error state with a retry when the list fails', async () => {
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockRejectedValue(new Error('boom')),
      getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() =>
      expect(within(container).getByText(/Couldn.t load managed servers/i)).toBeInTheDocument()
    );
    expect(within(container).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
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
      expect(within(container).getByText(/can.t use added servers yet/i)).toBeInTheDocument()
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
    expect(within(container).queryByText(/can.t use added servers yet/i)).not.toBeInTheDocument();
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
      expect(within(container).getByText(/Add this server to Test Agent\?/i)).toBeInTheDocument()
    );
    expect(within(container).getByText('npx')).toBeInTheDocument();

    fireEvent.click(within(container).getByRole('button', { name: /^add server$/i }));

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

  // DOR-3207, design pass row 11: a browser the agent-browser guard leaves out says why, calmly.
  it('says a left-out browser uses DorkOS’s own browser, with no red, code or actions', async () => {
    const leftOutBrowser = {
      name: 'browser',
      enabled: true,
      connection: {
        transport: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@playwright/mcp@0.0.82', '--executable-path', '/opt/my-chrome'],
        env: {},
      },
      addedAt: '2026-01-01T00:00:00.000Z',
      addedBy: 'operator',
      leftOut: 'own-browser-only' as const,
    };
    const transport = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([leftOutBrowser]),
      getMcpConfig: vi.fn().mockResolvedValue({
        servers: [{ name: 'browser', type: 'stdio', status: 'failed', error: 'spawn ENOENT' }],
      }),
    });
    const { container } = renderComponent(transport);

    await waitFor(() =>
      expect(
        within(container).getByText(
          "DorkOS uses its own browser for agents. Custom browser paths aren't allowed."
        )
      ).toBeInTheDocument()
    );
    expect(within(container).getByText('Not used')).toBeInTheDocument();
    expect(within(container).queryByText('Off')).not.toBeInTheDocument();
    expect(within(container).queryByText('Failed')).not.toBeInTheDocument();
    expect(within(container).queryByText(/ENOENT/)).not.toBeInTheDocument();
    expect(within(container).queryByRole('button', { name: /^Sign in/ })).not.toBeInTheDocument();
    expect(
      within(container).queryByRole('button', { name: /^(Test|Try)/ })
    ).not.toBeInTheDocument();
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
        within(container).getByText('Sign in to granola to use its tools.')
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
        within(container).getByText('Sign in to granola to use its tools.')
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
        within(container).queryByText('Sign in to granola to use its tools.')
      ).not.toBeInTheDocument()
    );
    expect(within(container).getByText('Signed in')).toBeInTheDocument();
    expect(within(container).queryByRole('button', { name: /^Sign in/ })).not.toBeInTheDocument();
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
        within(container).getByText(/Signed in\. Its tools are available/i)
      ).toBeInTheDocument()
    );
    expect(pollMcpSignin).toHaveBeenCalledWith('flow-1');
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
    expect(within(container).getByText('None. This server doesn’t need one.')).toBeInTheDocument();
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

  it('keeps configured browser servers without offering the superseded browser setup', async () => {
    const offered = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([managedServer]),
      getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
    });
    const first = renderComponent(offered);
    await waitFor(() =>
      expect(within(first.container).getByText(managedServer.name)).toBeInTheDocument()
    );
    expect(within(first.container).queryByText('Signed-in browser')).not.toBeInTheDocument();
    expect(
      within(first.container).queryByRole('button', { name: 'Give it the browser' })
    ).not.toBeInTheDocument();
    expect(offered.getAgentBrowserPreset).not.toHaveBeenCalled();
    expect(offered.addAgentMcpServer).not.toHaveBeenCalled();
    first.unmount();

    const alreadyHas = createMockTransport({
      listAgentMcpServers: vi.fn().mockResolvedValue([
        {
          ...managedServer,
          name: 'my-browser',
          connection: {
            transport: 'stdio',
            command: 'npx',
            args: ['@playwright/mcp@0.0.82', '--isolated', '--storage-state', '/s.json'],
            env: {},
          },
        },
      ]),
      getMcpConfig: vi.fn().mockResolvedValue({ servers: [] }),
    });
    const second = renderComponent(alreadyHas);
    await waitFor(() =>
      expect(within(second.container).getByText('my-browser')).toBeInTheDocument()
    );
    expect(within(second.container).queryByText('Signed-in browser')).not.toBeInTheDocument();
    expect(alreadyHas.getAgentBrowserPreset).not.toHaveBeenCalled();
    expect(alreadyHas.addAgentMcpServer).not.toHaveBeenCalled();
    expect(alreadyHas.removeAgentMcpServer).not.toHaveBeenCalled();
    expect(alreadyHas.disableAgentMcpServer).not.toHaveBeenCalled();
  });
});
