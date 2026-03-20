// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('@/layers/entities/relay', () => ({
  useRelayEnabled: vi.fn(() => true),
}));
vi.mock('@/layers/entities/pulse', () => ({
  usePulseEnabled: vi.fn(() => true),
}));
vi.mock('../model/use-agent-context-config', () => ({
  useAgentContextConfig: vi.fn(() => ({
    config: { relayTools: true, meshTools: true, adapterTools: true, pulseTools: true },
    updateConfig: vi.fn(),
  })),
}));

import { CapabilitiesTab } from '../ui/CapabilitiesTab';
import { useRelayEnabled } from '@/layers/entities/relay';
import { usePulseEnabled } from '@/layers/entities/pulse';
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
 * Helper to scope queries to the rendered container, avoiding duplicates
 * from portal-based components or React strict mode.
 * Wraps in TooltipProvider since ToolGroupRow uses Tooltip.
 */
function renderTab(agent: AgentManifest, onUpdate: ReturnType<typeof vi.fn>) {
  const { container } = render(
    <TooltipProvider>
      <CapabilitiesTab agent={agent} onUpdate={onUpdate} />
    </TooltipProvider>
  );
  return within(container);
}

describe('CapabilitiesTab', () => {
  let onUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onUpdate = vi.fn();
    // Re-establish default mock return values after clearAllMocks
    vi.mocked(useRelayEnabled).mockReturnValue(true);
    vi.mocked(usePulseEnabled).mockReturnValue(true);
    vi.mocked(useAgentContextConfig).mockReturnValue({
      config: { relayTools: true, meshTools: true, adapterTools: true, pulseTools: true },
      updateConfig: vi.fn(),
    });
  });

  it('renders existing capabilities as badges', () => {
    const view = renderTab(baseAgent, onUpdate);

    expect(view.getByText('code-review')).toBeInTheDocument();
    expect(view.getByText('testing')).toBeInTheDocument();
  });

  it('adds a capability when Enter is pressed', () => {
    const view = renderTab(baseAgent, onUpdate);

    const input = view.getByPlaceholderText('Add capability and press Enter');
    fireEvent.change(input, { target: { value: 'deployment' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onUpdate).toHaveBeenCalledWith({
      capabilities: ['code-review', 'testing', 'deployment'],
    });
  });

  it('does not add duplicate capabilities', () => {
    const view = renderTab(baseAgent, onUpdate);

    const input = view.getByPlaceholderText('Add capability and press Enter');
    fireEvent.change(input, { target: { value: 'code-review' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('does not add empty capabilities', () => {
    const view = renderTab(baseAgent, onUpdate);

    const input = view.getByPlaceholderText('Add capability and press Enter');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('removes a capability when X button is clicked', () => {
    const view = renderTab(baseAgent, onUpdate);

    const removeBtn = view.getByLabelText('Remove code-review');
    fireEvent.click(removeBtn);

    expect(onUpdate).toHaveBeenCalledWith({
      capabilities: ['testing'],
    });
  });

  it('renders response mode dropdown with current value', () => {
    const view = renderTab(baseAgent, onUpdate);

    expect(view.getByText('Always respond')).toBeInTheDocument();
  });

  it('renders budget fields with default values', () => {
    const view = renderTab(baseAgent, onUpdate);

    const spinbuttons = view.getAllByRole('spinbutton');
    expect(spinbuttons).toHaveLength(2);
    expect(spinbuttons[0]).toHaveValue(5);
    expect(spinbuttons[1]).toHaveValue(100);
  });

  it('renders namespace input', () => {
    const view = renderTab(baseAgent, onUpdate);

    expect(view.getByPlaceholderText('Optional grouping namespace')).toBeInTheDocument();
  });

  it('debounces namespace input and calls onUpdate after delay', () => {
    vi.useFakeTimers();
    const view = renderTab(baseAgent, onUpdate);

    const input = view.getByPlaceholderText('Optional grouping namespace');
    fireEvent.change(input, { target: { value: 'my-ns' } });

    // Should not fire immediately
    expect(onUpdate).not.toHaveBeenCalled();

    // After debounce, should fire
    vi.advanceTimersByTime(500);
    expect(onUpdate).toHaveBeenCalledWith({ namespace: 'my-ns' });

    vi.useRealTimers();
  });

  it('flushes namespace on blur without waiting for debounce', () => {
    vi.useFakeTimers();
    const view = renderTab(baseAgent, onUpdate);

    const input = view.getByPlaceholderText('Optional grouping namespace');
    fireEvent.change(input, { target: { value: 'blur-ns' } });
    fireEvent.blur(input);

    expect(onUpdate).toHaveBeenCalledWith({ namespace: 'blur-ns' });

    vi.useRealTimers();
  });

  describe('Tool Groups section', () => {
    it('renders all four tool group toggles', () => {
      const view = renderTab(baseAgent, onUpdate);
      expect(view.getByText('Pulse (Scheduling)')).toBeInTheDocument();
      expect(view.getByText('Relay (Messaging)')).toBeInTheDocument();
      expect(view.getByText('Mesh (Discovery)')).toBeInTheDocument();
      expect(view.getByText('Relay Adapters')).toBeInTheDocument();
    });

    it('renders Core Tools row with "Always enabled" label', () => {
      const view = renderTab(baseAgent, onUpdate);
      expect(view.getByText('Core Tools')).toBeInTheDocument();
      expect(view.getByText('Always enabled')).toBeInTheDocument();
    });

    it('shows Inherited label when agent has no override', () => {
      const view = renderTab({ ...baseAgent, enabledToolGroups: {} }, onUpdate);
      const inherited = view.getAllByText('Inherited');
      expect(inherited.length).toBe(4);
    });

    it('shows Overridden: Off label when agent explicitly disables pulse', () => {
      const view = renderTab({ ...baseAgent, enabledToolGroups: { pulse: false } }, onUpdate);
      expect(view.getByText('Overridden: Off')).toBeInTheDocument();
    });

    it('shows Overridden: On label when agent explicitly enables a domain', () => {
      const view = renderTab({ ...baseAgent, enabledToolGroups: { mesh: true } }, onUpdate);
      expect(view.getByText('Overridden: On')).toBeInTheDocument();
    });

    it('calls onUpdate with updated enabledToolGroups when toggle changes', () => {
      const view = renderTab(baseAgent, onUpdate);
      // The 4 tool group switches come after 2 budget spinbuttons; get all switches
      const switches = view.getAllByRole('switch');
      // Click the first tool group switch (Pulse)
      fireEvent.click(switches[0]);
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ enabledToolGroups: expect.any(Object) })
      );
    });

    it('Reset button clears the per-agent override', () => {
      const view = renderTab({ ...baseAgent, enabledToolGroups: { pulse: false } }, onUpdate);
      const resetBtn = view.getByLabelText('Reset Pulse (Scheduling) to default');
      fireEvent.click(resetBtn);
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ enabledToolGroups: {} }));
    });

    it('shows disabled switch when server has relay off', () => {
      vi.mocked(useRelayEnabled).mockReturnValue(false);
      const view = renderTab(baseAgent, onUpdate);
      // Relay and Adapter switches should be disabled (server off state)
      const relayRow = view.getByText('Relay (Messaging)').closest('div')!.parentElement!;
      const switchInRow = within(relayRow).getByRole('switch');
      expect(switchInRow).toBeDisabled();
    });

    it('shows disabled switch when server has pulse off', () => {
      vi.mocked(usePulseEnabled).mockReturnValue(false);
      const view = renderTab(baseAgent, onUpdate);
      const pulseRow = view.getByText('Pulse (Scheduling)').closest('div')!.parentElement!;
      const switchInRow = within(pulseRow).getByRole('switch');
      expect(switchInRow).toBeDisabled();
    });
  });
});
