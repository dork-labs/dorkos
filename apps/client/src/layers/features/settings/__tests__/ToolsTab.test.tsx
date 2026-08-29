/**
 * @vitest-environment jsdom
 *
 * Settings → Tools tab (spec team-room-home D6, task 4.6).
 *
 * Two different switches live on this tab and the difference matters:
 *
 * - The **tool-group** switches write `agentContext.*Tools`. They decide whether
 *   a group's tool docs reach an agent's context, and they take effect on the
 *   next turn.
 * - The **background-system** switches write `scheduler.enabled` and
 *   `relay.enabled`. They decide whether DorkOS starts those subsystems at all,
 *   which only a restart can change, so the row says so.
 *
 * Both are asserted end to end here: click → `transport.updateConfig` payload →
 * the stored value showing up again on a fresh mount.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';

// The tab reads the settings deep link, which needs a router. Only those two
// hooks are replaced; `TransportProvider`/`useTransport` stay real so the test
// drives the component through an actual transport.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useSettingsDeepLink: () => ({
      isOpen: false,
      activeTab: null,
      section: null,
      open: vi.fn(),
      close: vi.fn(),
    }),
    useDeepLinkScroll: () => undefined,
  };
});

import { ToolsTab } from '../ui/ToolsTab';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  // Radix Collapsible (the Scheduling row's expander) measures its content.
  Element.prototype.scrollIntoView = vi.fn();
});

interface ConfigOverrides {
  /** Whether the Tasks subsystem is running right now. */
  tasksRunning?: boolean;
  /** What `scheduler.enabled` says on disk. */
  tasksInConfig?: boolean;
  /** Whether an environment variable decides Tasks instead of the setting. */
  tasksLockedByEnv?: boolean;
  /** Whether the Relay subsystem is running right now. */
  relayRunning?: boolean;
  /** What `relay.enabled` says on disk. */
  relayInConfig?: boolean;
  /** Whether an environment variable decides Relay instead of the setting. */
  relayLockedByEnv?: boolean;
  /** Why Relay failed to start, when it did. */
  relayInitError?: string;
  /** The `agentContext` tool-group flags. */
  agentContext?: Partial<{
    tasksTools: boolean;
    relayTools: boolean;
    meshTools: boolean;
    adapterTools: boolean;
  }>;
}

function buildConfig(o: ConfigOverrides = {}) {
  return {
    version: '1.0.0',
    port: 4242,
    uptime: 0,
    workingDirectory: '/test',
    nodeVersion: 'v22.0.0',
    platform: 'darwin-arm64',
    runtimes: ['claude-code'],
    claudeCliPath: null,
    boundary: '/test',
    dorkHome: '/test/.dork',
    tunnel: {
      enabled: false,
      connected: false,
      url: null,
      authEnabled: false,
      tokenConfigured: false,
    },
    tasks: {
      enabled: o.tasksRunning ?? true,
      enabledInConfig: o.tasksInConfig ?? true,
      lockedByEnv: o.tasksLockedByEnv ?? false,
    },
    relay: {
      enabled: o.relayRunning ?? true,
      enabledInConfig: o.relayInConfig ?? true,
      lockedByEnv: o.relayLockedByEnv ?? false,
      ...(o.relayInitError && { initError: o.relayInitError }),
    },
    scheduler: { enabled: true, maxConcurrentRuns: 1, retentionCount: 100 },
    agentContext: {
      tasksTools: true,
      relayTools: true,
      meshTools: true,
      adapterTools: true,
      ...o.agentContext,
    },
  };
}

function setup(overrides: ConfigOverrides = {}) {
  const transport = createMockTransport();
  const config = buildConfig(overrides);
  vi.mocked(transport.getConfig).mockResolvedValue(config as never);
  vi.mocked(transport.updateConfig).mockResolvedValue(undefined);
  vi.mocked(transport.listMeshAgents).mockResolvedValue({ agents: [], total: 0 } as never);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <TransportProvider transport={transport}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>{children}</TooltipProvider>
        </QueryClientProvider>
      </TransportProvider>
    );
  }

  return { transport, queryClient, Wrapper };
}

/** The `background systems` card, scoped so tool-group rows can't answer for it. */
function backgroundCard() {
  const card = screen.getByTestId('background-systems');
  return within(card);
}

/**
 * Wait until the config query has landed and the tree has stopped changing shape.
 *
 * The Scheduling row gains an expander only once `config.scheduler` arrives,
 * which swaps a plain row for a `Collapsible`-wrapped one and REPLACES its DOM
 * nodes. Grabbing a switch before that point hands the test a detached element
 * that no longer updates, so every query happens after this resolves.
 */
async function settled() {
  await screen.findByLabelText('Expand Scheduling settings');
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ToolsTab — tool-group switches', () => {
  it('renders a switch for the Scheduling and Messaging groups', async () => {
    const { Wrapper } = setup();
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    expect(screen.getByLabelText('Toggle Scheduling')).toBeInTheDocument();
    expect(screen.getByLabelText('Toggle Messaging')).toBeInTheDocument();
  });

  it('turning Scheduling off writes tasksTools: false', async () => {
    const user = userEvent.setup();
    const { transport, Wrapper } = setup();
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    await user.click(screen.getByLabelText('Toggle Scheduling'));

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          agentContext: expect.objectContaining({ tasksTools: false }),
        })
      );
    });
  });

  it('turning Messaging off writes relayTools: false', async () => {
    const user = userEvent.setup();
    const { transport, Wrapper } = setup();
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    await user.click(screen.getByLabelText('Toggle Messaging'));

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          agentContext: expect.objectContaining({ relayTools: false }),
        })
      );
    });
  });

  it('a stored off value comes back off on a fresh mount', async () => {
    const { Wrapper } = setup({ agentContext: { tasksTools: false, relayTools: false } });
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    expect(screen.getByLabelText('Toggle Scheduling')).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getByLabelText('Toggle Messaging')).toHaveAttribute('data-state', 'unchecked');
  });
});

describe('ToolsTab — background system switches', () => {
  it('turning scheduled runs off writes scheduler.enabled: false', async () => {
    const user = userEvent.setup();
    const { transport, Wrapper } = setup();
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    await user.click(backgroundCard().getByLabelText('Scheduled runs'));

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledWith({ scheduler: { enabled: false } });
    });
  });

  it('turning agent messaging off writes relay.enabled: false', async () => {
    const user = userEvent.setup();
    const { transport, Wrapper } = setup();
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    await user.click(backgroundCard().getByLabelText('Agent messaging'));

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledWith({ relay: { enabled: false } });
    });
  });

  it('turning one back on writes true', async () => {
    const user = userEvent.setup();
    const { transport, Wrapper } = setup({ tasksInConfig: false, tasksRunning: false });
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    const toggle = backgroundCard().getByLabelText('Scheduled runs');
    expect(toggle).toHaveAttribute('data-state', 'unchecked');
    await user.click(toggle);

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledWith({ scheduler: { enabled: true } });
    });
  });

  it('follows the stored setting, not what is running, so a fresh mount shows the choice', async () => {
    // The setting says off; the subsystem is still up because nothing restarted.
    const { Wrapper } = setup({ tasksInConfig: false, tasksRunning: true });
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    expect(backgroundCard().getByLabelText('Scheduled runs')).toHaveAttribute(
      'data-state',
      'unchecked'
    );
  });

  it('says a change waits for the next start when the setting and reality disagree', async () => {
    const { Wrapper } = setup({ relayInConfig: false, relayRunning: true });
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    expect(backgroundCard().getByText(/next time DorkOS starts/i)).toBeInTheDocument();
  });

  it('says nothing about restarting once the setting and reality agree', async () => {
    const { Wrapper } = setup();
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    expect(backgroundCard().queryByText(/next time DorkOS starts/i)).not.toBeInTheDocument();
  });

  // A system that is ON in config and NOT running has two very different
  // explanations, and only one of them is "you just changed this". If it crashed
  // at boot, "Saved. It takes effect the next time DorkOS starts" is a straight
  // falsehood, and it contradicts the failure warning already on the row above.
  it('says a system failed to start rather than claiming a change is pending', async () => {
    const { Wrapper } = setup({
      relayInConfig: true,
      relayRunning: false,
      relayInitError: 'ENOENT: no such file or directory',
    });
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    expect(backgroundCard().getByText(/failed to start/i)).toBeInTheDocument();
    expect(backgroundCard().queryByText(/Saved\./)).not.toBeInTheDocument();
  });

  it('still says a change is pending when the system is down with no error', async () => {
    const { Wrapper } = setup({ relayInConfig: false, relayRunning: true });
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    expect(backgroundCard().getByText(/Saved\./)).toBeInTheDocument();
  });

  // The environment variable is what is actually in force, so a locked switch
  // has to show what is RUNNING. Showing the stored value there says "messaging
  // is on" over a machine where messaging is off.
  it('a locked switch shows what is running, not the setting it overrules', async () => {
    const { Wrapper } = setup({
      relayLockedByEnv: true,
      relayInConfig: true,
      relayRunning: false,
    });
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    const toggle = backgroundCard().getByLabelText('Agent messaging');
    expect(toggle).toHaveAttribute('data-state', 'unchecked');
    expect(toggle).toBeDisabled();
  });

  it('locks one subsystem without touching the other', async () => {
    const { Wrapper } = setup({ relayLockedByEnv: true, tasksLockedByEnv: false });
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    expect(backgroundCard().getByLabelText('Agent messaging')).toBeDisabled();
    expect(backgroundCard().getByLabelText('Scheduled runs')).not.toBeDisabled();
    expect(backgroundCard().getByText(/DORKOS_RELAY_ENABLED/)).toBeInTheDocument();
    expect(backgroundCard().queryByText(/DORKOS_TASKS_ENABLED/)).not.toBeInTheDocument();
  });

  it('locks the switch and says why when an environment variable decides it', async () => {
    const { Wrapper } = setup({ relayLockedByEnv: true });
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    const toggle = backgroundCard().getByLabelText('Agent messaging');
    expect(toggle).toBeDisabled();
    expect(backgroundCard().getByText(/DORKOS_RELAY_ENABLED/)).toBeInTheDocument();
  });

  it('an older server that reports no stored value falls back to what is running', async () => {
    const transport = createMockTransport();
    const config = buildConfig();
    // Strip the fields a pre-4.6 server never sent.
    delete (config.tasks as Record<string, unknown>).enabledInConfig;
    delete (config.tasks as Record<string, unknown>).lockedByEnv;
    delete (config.relay as Record<string, unknown>).enabledInConfig;
    delete (config.relay as Record<string, unknown>).lockedByEnv;
    vi.mocked(transport.getConfig).mockResolvedValue(config as never);
    vi.mocked(transport.listMeshAgents).mockResolvedValue({ agents: [], total: 0 } as never);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    render(
      <TransportProvider transport={transport}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <ToolsTab />
          </TooltipProvider>
        </QueryClientProvider>
      </TransportProvider>
    );

    await settled();
    const toggle = backgroundCard().getByLabelText('Scheduled runs');
    expect(toggle).toHaveAttribute('data-state', 'checked');
    expect(toggle).not.toBeDisabled();
  });
});

/**
 * The one group on this screen that is a lock rather than a hint (DOR-1611).
 *
 * It carries NO switch here on purpose: the grant has no global default, and a
 * global twin would be a second and weaker path to the same permission. What it
 * shows instead is what the group is and where to turn it on.
 */
describe('ToolsTab — the Manage rooms row', () => {
  it('shows the group with no switch of its own', async () => {
    const { Wrapper } = setup();
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    expect(screen.getByText('Manage rooms')).toBeInTheDocument();
    expect(screen.getByText('Granted per agent')).toBeInTheDocument();
    // The four groups above each have one; this one must not, or the person
    // would be offered a global default that does not exist.
    expect(screen.queryByLabelText('Toggle Manage rooms')).not.toBeInTheDocument();
  });

  it('quotes no number of armed agents, because this screen cannot know one', async () => {
    // The row used to say "N agents can manage rooms", counted off
    // `GET /api/mesh/agents` — whose rows come from the SQLite cache, which has
    // no `enabled_tool_groups` column, so `rowToEntry` hardcodes `{}` and every
    // agent reads as ungranted (DOR-1611 review; the old test mocked a shape the
    // server never sends and so agreed with itself). A wrong count is worse than
    // none: this asserts the sentence is gone in BOTH directions, so restoring a
    // number quietly is not something a passing suite can hide.
    const { transport, Wrapper } = setup();
    vi.mocked(transport.listMeshAgents).mockResolvedValue({
      total: 3,
      // The real shape: the cache serves this, whatever the manifests say.
      agents: Array.from({ length: 3 }, (_, index) => ({
        id: `agent-${index}`,
        name: `agent-${index}`,
        enabledToolGroups: {},
      })),
    } as never);
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    expect(screen.queryByText(/can manage rooms/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No agents/)).not.toBeInTheDocument();
  });

  it('tells the truth about which switch blocks, on both halves of the screen', async () => {
    const { Wrapper } = setup();
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    // The four above: guidance.
    expect(screen.getByText(/an agent that asks for one anyway still gets it/)).toBeInTheDocument();
    // This one: a refusal, and where to change it.
    expect(screen.getByText(/this one blocks/)).toBeInTheDocument();
    expect(screen.getByText(/in that agent’s own Tools settings/)).toBeInTheDocument();
  });

  it('names the tools behind it from the live catalog', async () => {
    const { transport, Wrapper } = setup();
    vi.mocked(transport.getCapabilityCatalog).mockResolvedValue({
      catalogVersion: 'test',
      generatedAt: '2026-01-01T00:00:00.000Z',
      capabilities: [
        {
          id: 'rooms.create',
          title: 'Open a room',
          description: 'x',
          tier: 'act',
          inputSchema: {},
          outputSchema: {},
          surfaces: { mcp: { toolName: 'create_room', servers: ['external'] } },
          toolGroup: 'roomsManage',
        },
        {
          id: 'rooms.post',
          title: 'Post',
          description: 'x',
          tier: 'act',
          inputSchema: {},
          outputSchema: {},
          surfaces: { mcp: { toolName: 'post_to_room', servers: ['external'] } },
        },
      ],
    } as never);
    render(<ToolsTab />, { wrapper: Wrapper });

    await settled();
    // One tool declares the grant; the conversation verb beside it does not, and
    // must not be counted into a group it never joined.
    const badge = await screen.findByText('1');
    expect(badge).toBeInTheDocument();
  });
});
