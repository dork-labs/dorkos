// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
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

import { ToolsTab } from '../ui/ToolsTab';
import { useRelayEnabled } from '@/layers/entities/relay';
import { useTasksEnabled } from '@/layers/entities/tasks';
import { useAgentContextConfig } from '../model/use-agent-context-config';
import { TooltipProvider } from '@/layers/shared/ui';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

const baseAgent: AgentManifest = {
  id: '01HZ0000000000000000000001',
  name: 'test-agent',
  description: 'A mock agent',
  runtime: 'claude-code',
  capabilities: ['code-review', 'testing'],
  behavior: { responseMode: 'always' },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  registeredAt: '2025-01-01T00:00:00.000Z',
  registeredBy: 'test',
  personaEnabled: true,
  enabledToolGroups: {},
};

/**
 * Helper to scope queries to the rendered container.
 * Wraps in TooltipProvider since ToolGroupRow uses Tooltip.
 */
function renderTab(agent: AgentManifest, onUpdate: ReturnType<typeof vi.fn>) {
  const { container } = render(
    <TooltipProvider>
      <ToolsTab agent={agent} onUpdate={onUpdate} />
    </TooltipProvider>
  );
  return within(container);
}

describe('ToolsTab', () => {
  let onUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onUpdate = vi.fn();
    vi.mocked(useRelayEnabled).mockReturnValue(true);
    vi.mocked(useTasksEnabled).mockReturnValue(true);
    vi.mocked(useAgentContextConfig).mockReturnValue({
      config: { relayTools: true, meshTools: true, adapterTools: true, tasksTools: true },
      updateConfig: vi.fn(),
    });
  });

  describe('Tool Groups section', () => {
    it('renders all four tool group toggles with updated labels', () => {
      const view = renderTab(baseAgent, onUpdate);
      expect(view.getByText('Scheduling')).toBeInTheDocument();
      expect(view.getByText('Messaging')).toBeInTheDocument();
      expect(view.getByText('Agent Discovery')).toBeInTheDocument();
      expect(view.getByText('External Channels')).toBeInTheDocument();
    });

    it('shows core tools footnote instead of row', () => {
      const view = renderTab(baseAgent, onUpdate);
      expect(
        view.getByText('Core tools (ping, server info, agent identity) are always available.')
      ).toBeInTheDocument();
    });

    it('shows "default" badge when agent has no override', () => {
      const view = renderTab({ ...baseAgent, enabledToolGroups: {} }, onUpdate);
      const defaultBadges = view.getAllByText('default');
      expect(defaultBadges.length).toBe(4);
    });

    it('shows reset button when agent explicitly disables a domain', () => {
      const view = renderTab({ ...baseAgent, enabledToolGroups: { tasks: false } }, onUpdate);
      expect(view.getByLabelText('Reset Scheduling to default')).toBeInTheDocument();
    });

    it('calls onUpdate with updated enabledToolGroups when toggle changes', () => {
      const view = renderTab(baseAgent, onUpdate);
      const switches = view.getAllByRole('switch');
      // Click the first tool group switch (Scheduling)
      fireEvent.click(switches[0]);
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ enabledToolGroups: expect.any(Object) })
      );
    });

    it('Reset button clears the per-agent override', () => {
      const view = renderTab({ ...baseAgent, enabledToolGroups: { tasks: false } }, onUpdate);
      const resetBtn = view.getByLabelText('Reset Scheduling to default');
      fireEvent.click(resetBtn);
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ enabledToolGroups: {} }));
    });

    it('shows disabled switch when server has relay off', () => {
      vi.mocked(useRelayEnabled).mockReturnValue(false);
      const view = renderTab(baseAgent, onUpdate);
      const messagingRow = view.getByText('Messaging').closest('div')!.parentElement!;
      const switchInRow = within(messagingRow).getByRole('switch');
      expect(switchInRow).toBeDisabled();
    });

    it('shows disabled switch when server has tasks off', () => {
      vi.mocked(useTasksEnabled).mockReturnValue(false);
      const view = renderTab(baseAgent, onUpdate);
      const schedulingRow = view.getByText('Scheduling').closest('div')!.parentElement!;
      const switchInRow = within(schedulingRow).getByRole('switch');
      expect(switchInRow).toBeDisabled();
    });
  });

  describe('Budget section', () => {
    it('shows collapsed limits with summary badge', () => {
      const view = renderTab(baseAgent, onUpdate);
      expect(view.getByText('Limits')).toBeInTheDocument();
      expect(view.getByText('5 hops · 100 calls/hr')).toBeInTheDocument();
    });
  });
});
