// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('@/layers/entities/relay', () => ({
  useRelayEnabled: vi.fn(() => true),
}));
vi.mock('../model/use-agent-context-config', () => ({
  useAgentContextConfig: vi.fn(() => ({
    config: { relayTools: true, meshTools: true, adapterTools: true },
    updateConfig: vi.fn(),
  })),
}));

import { ContextTab } from '../ui/ContextTab';
import { useRelayEnabled } from '@/layers/entities/relay';
import { useAgentContextConfig } from '../model/use-agent-context-config';

/**
 * Helper to scope queries to the rendered container, avoiding duplicates
 * from portal-based components or React strict mode.
 */
function renderTab() {
  const { container } = render(<ContextTab />);
  return within(container);
}

describe('ContextTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRelayEnabled).mockReturnValue(true);
    vi.mocked(useAgentContextConfig).mockReturnValue({
      config: { relayTools: true, meshTools: true, adapterTools: true },
      updateConfig: vi.fn(),
    });
  });

  it('renders all three toggle sections', () => {
    const view = renderTab();
    expect(view.getByText('Relay Tools')).toBeInTheDocument();
    expect(view.getByText('Mesh Tools')).toBeInTheDocument();
    expect(view.getByText('Adapter Tools')).toBeInTheDocument();
  });

  it('renders description text', () => {
    const view = renderTab();
    expect(
      view.getByText(/Control which tool usage instructions are injected/)
    ).toBeInTheDocument();
  });

  it('shows preview when toggle is on and feature is available', () => {
    const view = renderTab();
    // Relay preview should contain subject hierarchy
    expect(view.getByText(/relay\.agent\.\{sessionId\}/)).toBeInTheDocument();
    // Mesh preview should contain lifecycle steps
    expect(view.getByText(/mesh_discover/)).toBeInTheDocument();
    // Adapter preview should contain binding info
    expect(view.getByText(/binding_create/)).toBeInTheDocument();
  });

  it('hides preview when toggle is off', () => {
    vi.mocked(useAgentContextConfig).mockReturnValue({
      config: { relayTools: false, meshTools: true, adapterTools: true },
      updateConfig: vi.fn(),
    });
    const view = renderTab();
    // Relay preview should be hidden
    expect(view.queryByText(/relay\.agent\.\{sessionId\}/)).not.toBeInTheDocument();
    // Mesh preview should still show
    expect(view.getByText(/mesh_discover/)).toBeInTheDocument();
  });

  it('disables relay and adapter switches when relay is off', () => {
    vi.mocked(useRelayEnabled).mockReturnValue(false);
    const view = renderTab();
    const switches = view.getAllByRole('switch');
    // Relay switch (index 0) should be disabled
    expect(switches[0]).toBeDisabled();
    // Mesh switch (index 1) should be enabled
    expect(switches[1]).not.toBeDisabled();
    // Adapter switch (index 2) should be disabled
    expect(switches[2]).toBeDisabled();
  });

  it('shows "Relay is disabled" badge when relay is off', () => {
    vi.mocked(useRelayEnabled).mockReturnValue(false);
    const view = renderTab();
    const badges = view.getAllByText('Relay is disabled');
    expect(badges).toHaveLength(2); // One for relay section, one for adapter section
  });

  it('hides preview when feature is unavailable even if toggle is on', () => {
    vi.mocked(useRelayEnabled).mockReturnValue(false);
    vi.mocked(useAgentContextConfig).mockReturnValue({
      config: { relayTools: true, meshTools: true, adapterTools: true },
      updateConfig: vi.fn(),
    });
    const view = renderTab();
    // Relay and adapter previews should be hidden (feature unavailable)
    expect(view.queryByText(/relay\.agent\.\{sessionId\}/)).not.toBeInTheDocument();
    expect(view.queryByText(/binding_create/)).not.toBeInTheDocument();
    // Mesh preview should show (always available)
    expect(view.getByText(/mesh_discover/)).toBeInTheDocument();
  });

  it('calls updateConfig when a toggle is switched', () => {
    const updateConfig = vi.fn();
    vi.mocked(useAgentContextConfig).mockReturnValue({
      config: { relayTools: true, meshTools: true, adapterTools: true },
      updateConfig,
    });
    const view = renderTab();

    const switches = view.getAllByRole('switch');
    // Click mesh toggle (index 1)
    fireEvent.click(switches[1]);

    expect(updateConfig).toHaveBeenCalledWith({ meshTools: false });
  });

  it('calls updateConfig with correct key for relay toggle', () => {
    const updateConfig = vi.fn();
    vi.mocked(useAgentContextConfig).mockReturnValue({
      config: { relayTools: true, meshTools: true, adapterTools: true },
      updateConfig,
    });
    const view = renderTab();

    const switches = view.getAllByRole('switch');
    // Click relay toggle (index 0)
    fireEvent.click(switches[0]);

    expect(updateConfig).toHaveBeenCalledWith({ relayTools: false });
  });

  it('has accessible labels for all switches', () => {
    const view = renderTab();
    expect(view.getByLabelText('Toggle Relay Tools context')).toBeInTheDocument();
    expect(view.getByLabelText('Toggle Mesh Tools context')).toBeInTheDocument();
    expect(view.getByLabelText('Toggle Adapter Tools context')).toBeInTheDocument();
  });
});
