// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';

vi.mock('@/layers/entities/relay', () => ({
  useRelayEnabled: vi.fn(() => true),
}));
vi.mock('@/layers/entities/tasks', () => ({
  useTasksEnabled: vi.fn(() => true),
}));
vi.mock('../model/use-agent-context-config', () => ({
  useAgentContextConfig: vi.fn(() => ({
    config: { relayTools: true, meshTools: true, adapterTools: true, tasksTools: true },
    updateConfig: vi.fn(),
  })),
}));
vi.mock('@/layers/entities/runtime', () => ({
  // Default: the runtime supports MCP (Claude) → tool groups render.
  useCapabilitiesForRuntime: vi.fn(() => ({ supportsMcp: true })),
}));
// The Manage-rooms card reads the live capability catalog for the tool names
// behind the grant, and writes through the OPERATOR route. Both are mocked here
// the same way every other entity in this file is.
vi.mock('@/layers/entities/capability', () => ({
  useToolNamesForGroup: vi.fn(() => ['add_room_members', 'create_room']),
}));
vi.mock('@/layers/entities/mesh', () => ({
  useUpdateAgent: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));
// The managed-MCP section has its own test (AgentMcpServers.test.tsx); stub it
// here so ToolsTab tests stay focused on the tool-group toggles.
vi.mock('../ui/AgentMcpServers', () => ({
  AgentMcpServers: () => <div data-testid="agent-mcp-servers" />,
}));

import { ToolsTab } from '../ui/ToolsTab';
import { useRelayEnabled } from '@/layers/entities/relay';
import { useTasksEnabled } from '@/layers/entities/tasks';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import { useToolNamesForGroup } from '@/layers/entities/capability';
import { useUpdateAgent } from '@/layers/entities/mesh';
import { useAgentContextConfig } from '../model/use-agent-context-config';
import { agentKeys } from '@/layers/entities/agent';
import { TEAM_ROSTER_KEY } from '@/layers/entities/team';
import { TooltipProvider } from '@/layers/shared/ui';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

const baseAgent: AgentManifest = {
  workspace: { mode: 'home' },
  id: '01HZ0000000000000000000001',
  name: 'test-agent',
  description: 'A mock agent',
  runtime: 'claude-code',
  capabilities: ['code-review', 'testing'],
  behavior: { responseMode: 'always' },
  registeredAt: '2025-01-01T00:00:00.000Z',
  registeredBy: 'test',
  personaEnabled: true,
  enabledToolGroups: {},
  mcpServers: [],
};

/**
 * Helper to scope queries to the rendered container.
 * Wraps in TooltipProvider since ToolGroupRow uses Tooltip.
 */
function renderTab(agent: AgentManifest, client: QueryClient = new QueryClient()) {
  const { container } = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToolsTab agent={agent} projectPath="/projects/test" />
      </TooltipProvider>
    </QueryClientProvider>
  );
  return within(container);
}

/**
 * Open the tier-ceiling select.
 *
 * Keyboard, not a click: jsdom has no pointer capture, so Radix's trigger never
 * sees the pointer sequence that opens it. Its list renders in a portal outside
 * the container {@link renderTab} scopes to, which is why the options are read
 * off `screen`.
 *
 * @param view - The scoped queries {@link renderTab} returned.
 */
function openCeiling(view: ReturnType<typeof renderTab>): void {
  fireEvent.keyDown(view.getByLabelText('The most this agent can ever do'), { key: 'ArrowDown' });
}

describe('ToolsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRelayEnabled).mockReturnValue(true);
    vi.mocked(useTasksEnabled).mockReturnValue(true);
    vi.mocked(useCapabilitiesForRuntime).mockReturnValue({
      supportsMcp: true,
    } as RuntimeCapabilities);
    vi.mocked(useAgentContextConfig).mockReturnValue({
      config: { relayTools: true, meshTools: true, adapterTools: true, tasksTools: true },
      updateConfig: vi.fn(),
    });
    vi.mocked(useToolNamesForGroup).mockReturnValue(['add_room_members', 'create_room']);
    vi.mocked(useUpdateAgent).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateAgent>);
  });

  describe('Tool Groups section', () => {
    it('renders all four tool group toggles with updated labels', () => {
      const view = renderTab(baseAgent);
      expect(view.getByText('Scheduling')).toBeInTheDocument();
      expect(view.getByText('Messaging')).toBeInTheDocument();
      expect(view.getByText('Agent discovery')).toBeInTheDocument();
      expect(view.getByText('Connection management')).toBeInTheDocument();
    });

    it('shows core tools footnote instead of row', () => {
      const view = renderTab(baseAgent);
      // "Always REGISTERED", not "in every agent's instructions" (DOR-509 review).
      // A first pass at this footnote said "instructions", which is false: there is
      // no core-tools context block. `context-builder.ts` assembles exactly five
      // blocks (relay, mesh, adapter, tasks, ui) and `get_server_info` appears in no
      // prompt-building file at all. What IS unconditional is registration —
      // `mcp-tools/index.ts` spreads `getCoreTools(deps)` with no toolConfig branch.
      // Registration is the honest word, and it is the one the toggles never touch.
      expect(
        view.getByText(
          'Core tools (ping, server info, agent identity) are always registered, whatever you set here.'
        )
      ).toBeInTheDocument();
    });

    it('shows "default" badge when agent has no override', () => {
      const view = renderTab({ ...baseAgent, enabledToolGroups: {} });
      const defaultBadges = view.getAllByText('default');
      expect(defaultBadges.length).toBe(4);
    });

    it('shows reset button when agent explicitly disables a domain', () => {
      const view = renderTab({ ...baseAgent, enabledToolGroups: { tasks: false } });
      expect(view.getByLabelText('Reset Scheduling to default')).toBeInTheDocument();
    });

    it('writes a toggle through the OPERATOR route, never the agent self-edit route', () => {
      // DOR-1506: `PATCH /api/agents/current` now refuses all five keys of this
      // object, because a per-agent value BEATS the global `agentContext.*`
      // switch a person set. The cockpit is the person, so it uses the mesh
      // route — the same split the grant and the ceiling below already use.
      const mutate = vi.fn();
      vi.mocked(useUpdateAgent).mockReturnValue({
        mutate,
        isPending: false,
      } as unknown as ReturnType<typeof useUpdateAgent>);
      const view = renderTab(baseAgent);

      fireEvent.click(view.getByLabelText('Toggle Scheduling tools'));

      expect(mutate).toHaveBeenCalledWith(
        // Off, because the switch reads ON from the inherited global default.
        { id: baseAgent.id, updates: { enabledToolGroups: { tasks: false } } },
        expect.anything()
      );
    });

    it('Reset button clears the per-agent override', () => {
      const mutate = vi.fn();
      vi.mocked(useUpdateAgent).mockReturnValue({
        mutate,
        isPending: false,
      } as unknown as ReturnType<typeof useUpdateAgent>);
      const view = renderTab({ ...baseAgent, enabledToolGroups: { tasks: false } });

      fireEvent.click(view.getByLabelText('Reset Scheduling to default'));

      expect(mutate).toHaveBeenCalledWith(
        { id: baseAgent.id, updates: { enabledToolGroups: {} } },
        expect.anything()
      );
    });

    it('refreshes the manifest it renders, so a toggle does not snap back', () => {
      // Same defect `ManageRoomsCard` documents, now on the four soft toggles:
      // the mesh mutation clears `['mesh','agents']` and stops, while this tab
      // renders the agent `useCurrentAgent` holds.
      const mutate = vi.fn(
        (_vars: unknown, options?: { onSettled?: () => void }) => void options?.onSettled?.()
      );
      vi.mocked(useUpdateAgent).mockReturnValue({
        mutate,
        isPending: false,
      } as unknown as ReturnType<typeof useUpdateAgent>);
      const client = new QueryClient();
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      const view = renderTab(baseAgent, client);

      fireEvent.click(view.getByLabelText('Toggle Scheduling tools'));

      const asked = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
      expect(asked).toContain(JSON.stringify(agentKeys.all));
      expect(asked).toContain(JSON.stringify(TEAM_ROSTER_KEY));
    });

    it('shows disabled switch when server has relay off', () => {
      vi.mocked(useRelayEnabled).mockReturnValue(false);
      const view = renderTab(baseAgent);
      const messagingRow = view.getByText('Messaging').closest('div')!.parentElement!;
      const switchInRow = within(messagingRow).getByRole('switch');
      expect(switchInRow).toBeDisabled();
    });

    it('shows disabled switch when server has tasks off', () => {
      vi.mocked(useTasksEnabled).mockReturnValue(false);
      const view = renderTab(baseAgent);
      const schedulingRow = view.getByText('Scheduling').closest('div')!.parentElement!;
      const switchInRow = within(schedulingRow).getByRole('switch');
      expect(switchInRow).toBeDisabled();
    });
  });

  describe('Runtime MCP gating', () => {
    it('hides the tool-group toggles when the runtime cannot consume MCP', () => {
      vi.mocked(useCapabilitiesForRuntime).mockReturnValue({
        supportsMcp: false,
      } as RuntimeCapabilities);
      const view = renderTab({ ...baseAgent, runtime: 'codex' });

      // None of the DorkOS tool-group toggles render...
      expect(view.queryByText('Scheduling')).not.toBeInTheDocument();
      expect(view.queryByText('Messaging')).not.toBeInTheDocument();
      expect(view.queryByText('Agent discovery')).not.toBeInTheDocument();
      expect(view.queryByText('Connection management')).not.toBeInTheDocument();
      // ...and an explanatory note takes their place.
      expect(view.getByText(/does not support DorkOS tool groups/i)).toBeInTheDocument();
      // The ONE switch still on screen is the rooms grant, which is deliberately
      // not part of this branch: it is enforced for every runtime, and a Codex
      // agent reaches the same capabilities over the external MCP server
      // (DOR-1611). Asserted by name rather than by counting switches, so this
      // row keeps saying "the four are gone" rather than "nothing is here".
      expect(view.queryAllByRole('switch')).toHaveLength(1);
      expect(view.getByLabelText('Manage rooms')).toBeInTheDocument();
    });

    it('keeps the tool-group toggles for an MCP-capable runtime', () => {
      vi.mocked(useCapabilitiesForRuntime).mockReturnValue({
        supportsMcp: true,
      } as RuntimeCapabilities);
      const view = renderTab(baseAgent);
      expect(view.getByText('Scheduling')).toBeInTheDocument();
      expect(view.queryByText(/does not support DorkOS tool groups/i)).not.toBeInTheDocument();
    });
  });

  it('renders tool groups and MCP servers with no Limits control (the removed advisory budget)', () => {
    const view = renderTab(baseAgent);
    expect(view.getByText('Scheduling')).toBeInTheDocument();
    expect(view.queryByText('Limits')).not.toBeInTheDocument();
  });

  describe('Manage rooms — the one group that is a lock', () => {
    it('renders the switch, off until a person turns it on', () => {
      const view = renderTab(baseAgent);

      const toggle = view.getByLabelText('Manage rooms');
      expect(toggle).toBeInTheDocument();
      expect(toggle).not.toBeChecked();
    });

    it('reads as on when the agent holds the grant', () => {
      const view = renderTab({ ...baseAgent, enabledToolGroups: { roomsManage: true } });

      expect(view.getByLabelText('Manage rooms')).toBeChecked();
    });

    it('writes through the OPERATOR route, never the agent self-edit route', () => {
      // The half that would silently break the feature. `PATCH
      // /api/agents/current` refuses this field by design, because a grant the
      // governed agent can set for itself is not a grant. The cockpit is the
      // person, so it must use the mesh route.
      const mutate = vi.fn();
      vi.mocked(useUpdateAgent).mockReturnValue({
        mutate,
        isPending: false,
      } as unknown as ReturnType<typeof useUpdateAgent>);
      const view = renderTab(baseAgent);

      fireEvent.click(view.getByLabelText('Manage rooms'));

      expect(mutate).toHaveBeenCalledWith(
        {
          id: baseAgent.id,
          updates: { enabledToolGroups: { roomsManage: true } },
        },
        expect.anything()
      );
    });

    it('keeps the four documentation toggles when it writes the grant', () => {
      const mutate = vi.fn();
      vi.mocked(useUpdateAgent).mockReturnValue({
        mutate,
        isPending: false,
      } as unknown as ReturnType<typeof useUpdateAgent>);
      const view = renderTab({ ...baseAgent, enabledToolGroups: { tasks: false } });

      fireEvent.click(view.getByLabelText('Manage rooms'));

      expect(mutate).toHaveBeenCalledWith(
        {
          id: baseAgent.id,
          updates: { enabledToolGroups: { tasks: false, roomsManage: true } },
        },
        expect.anything()
      );
    });

    it('carries the grant along on a soft-toggle write, rather than clearing it', () => {
      // The mirror of the DOR-1611 defect, once both halves moved to the
      // operator route (DOR-1506). While the four toggles went through the agent
      // self-edit route the grant had to be STRIPPED — that route refuses any
      // body naming it — and the manifest write REPLACES `enabledToolGroups`
      // wholesale, so on the operator route the same strip would silently
      // disarm an agent a person had armed. Send the whole stored object.
      const mutate = vi.fn();
      vi.mocked(useUpdateAgent).mockReturnValue({
        mutate,
        isPending: false,
      } as unknown as ReturnType<typeof useUpdateAgent>);
      const view = renderTab({
        ...baseAgent,
        enabledToolGroups: { roomsManage: true, tasks: false },
      });

      fireEvent.click(view.getByLabelText('Toggle Scheduling tools'));

      expect(mutate).toHaveBeenCalledWith(
        {
          id: baseAgent.id,
          updates: { enabledToolGroups: { roomsManage: true, tasks: true } },
        },
        expect.anything()
      );
    });

    it('carries the grant through the RESET write too, not only the toggle write', () => {
      // The second door to the same outcome: "Reset Scheduling to default" also
      // rewrites the whole object, so it has to keep the grant for the same
      // reason.
      const mutate = vi.fn();
      vi.mocked(useUpdateAgent).mockReturnValue({
        mutate,
        isPending: false,
      } as unknown as ReturnType<typeof useUpdateAgent>);
      const view = renderTab({
        ...baseAgent,
        enabledToolGroups: { roomsManage: true, tasks: false },
      });

      fireEvent.click(view.getByLabelText('Reset Scheduling to default'));

      expect(mutate).toHaveBeenCalledWith(
        { id: baseAgent.id, updates: { enabledToolGroups: { roomsManage: true } } },
        expect.anything()
      );
    });

    it('refreshes the manifest it renders, so the switch does not snap back', () => {
      // The defect this pins. `useUpdateAgent` clears `['mesh','agents']` and
      // stops, and the agent on this page is read through `useCurrentAgent` —
      // so without these two the server stored the grant, the next render put
      // the switch back where it was, and a save that WORKED looked like a
      // refusal. Driven through the real `onSettled` the card hands the
      // mutation, rather than asserted against a callback nobody ran.
      const mutate = vi.fn(
        (_vars: unknown, options?: { onSettled?: () => void }) => void options?.onSettled?.()
      );
      vi.mocked(useUpdateAgent).mockReturnValue({
        mutate,
        isPending: false,
      } as unknown as ReturnType<typeof useUpdateAgent>);
      const client = new QueryClient();
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      const view = renderTab(baseAgent, client);

      fireEvent.click(view.getByLabelText('Manage rooms'));

      const asked = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
      expect(asked).toContain(JSON.stringify(agentKeys.all));
      expect(asked).toContain(JSON.stringify(TEAM_ROSTER_KEY));
    });

    it('says plainly that this one blocks, where the others do not', () => {
      const view = renderTab(baseAgent);

      expect(view.getByText(/This switch is a lock, not a hint/)).toBeInTheDocument();
      expect(view.getByText(/the agent cannot turn it on for itself/)).toBeInTheDocument();
      // And the four above it must not claim to block.
      expect(view.getByText(/an agent that asks for one anyway still gets it/)).toBeInTheDocument();
    });

    it('renders for a runtime that cannot take DorkOS tools in-session', () => {
      // The four toggles hide here — there is nothing to describe to that
      // runtime. This grant still applies: the agent reaches the same
      // capabilities over the external MCP server, and it is enforced there.
      vi.mocked(useCapabilitiesForRuntime).mockReturnValue({
        supportsMcp: false,
      } as RuntimeCapabilities);
      const view = renderTab(baseAgent);

      expect(view.getByLabelText('Manage rooms')).toBeInTheDocument();
      expect(view.getByText(/external MCP server/)).toBeInTheDocument();
    });

    it('names the tools behind the grant from the live catalog', () => {
      const view = renderTab(baseAgent);

      // The count badge, derived rather than listed — a static copy of this is
      // the drift DOR-499 deleted three times over.
      expect(view.getByText('2')).toBeInTheDocument();
    });
  });

  describe('the most this agent can ever do', () => {
    const CEILING_LABEL = 'The most this agent can ever do';

    it('reads as no extra limit for an agent nobody has capped', () => {
      const view = renderTab(baseAgent);

      expect(view.getByLabelText(CEILING_LABEL)).toHaveTextContent('No extra limit');
    });

    it('reads back the ceiling recorded on the manifest', () => {
      const view = renderTab({ ...baseAgent, tierCeiling: 'act' });

      expect(view.getByLabelText(CEILING_LABEL)).toHaveTextContent('Change things, never delete');
    });

    it('writes through the OPERATOR route, never the agent self-edit route', () => {
      // The half that would silently break the feature, exactly as for the grant
      // above: `PATCH /api/agents/current` refuses any change that WIDENS a
      // ceiling, whoever sends it, so a person raising one has to use the mesh
      // route (DOR-486).
      const mutate = vi.fn();
      vi.mocked(useUpdateAgent).mockReturnValue({
        mutate,
        isPending: false,
      } as unknown as ReturnType<typeof useUpdateAgent>);
      const view = renderTab({ ...baseAgent, tierCeiling: 'observe' });

      openCeiling(view);
      fireEvent.click(screen.getByRole('option', { name: 'No extra limit' }));

      expect(mutate).toHaveBeenCalledWith(
        { id: baseAgent.id, updates: { tierCeiling: 'destructive' } },
        expect.anything()
      );
    });

    it('refreshes the manifest it renders, so the choice does not snap back', () => {
      const mutate = vi.fn(
        (_vars: unknown, options?: { onSettled?: () => void }) => void options?.onSettled?.()
      );
      vi.mocked(useUpdateAgent).mockReturnValue({
        mutate,
        isPending: false,
      } as unknown as ReturnType<typeof useUpdateAgent>);
      const client = new QueryClient();
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      const view = renderTab(baseAgent, client);

      openCeiling(view);
      fireEvent.click(screen.getByRole('option', { name: 'Read only' }));

      const asked = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
      expect(asked).toContain(JSON.stringify(agentKeys.all));
      expect(asked).toContain(JSON.stringify(TEAM_ROSTER_KEY));
    });

    it('says that no approval can lift it, and who may loosen it', () => {
      const view = renderTab(baseAgent);

      expect(view.getByText(/no approval can unlock it/)).toBeInTheDocument();
      expect(view.getByText(/only you can loosen it/)).toBeInTheDocument();
    });

    it('renders for a runtime that cannot take DorkOS tools in-session', () => {
      // The cap is enforced at the capability gate, which every runtime reaches.
      vi.mocked(useCapabilitiesForRuntime).mockReturnValue({
        supportsMcp: false,
      } as RuntimeCapabilities);
      const view = renderTab(baseAgent);

      expect(view.getByLabelText(CEILING_LABEL)).toBeInTheDocument();
    });
  });
});
