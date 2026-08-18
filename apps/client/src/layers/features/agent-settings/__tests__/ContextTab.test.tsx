// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('@/layers/entities/relay', () => ({
  useRelayEnabled: vi.fn(() => true),
}));
vi.mock('../model/use-agent-context-config', () => ({
  useAgentContextConfig: vi.fn(() => ({
    config: { relayTools: true, meshTools: true, adapterTools: true, tasksTools: true },
    updateConfig: vi.fn(),
  })),
}));

import { AGENT_SUBJECT_FORMAT } from '@dorkos/shared/relay-schemas';
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

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('ContextTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRelayEnabled).mockReturnValue(true);
    vi.mocked(useAgentContextConfig).mockReturnValue({
      config: { relayTools: true, meshTools: true, adapterTools: true, tasksTools: true },
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
    expect(view.getByText(new RegExp(escapeRegExp(AGENT_SUBJECT_FORMAT)))).toBeInTheDocument();
    // Mesh preview should contain lifecycle steps
    expect(view.getByText(/mesh_discover/)).toBeInTheDocument();
    // Adapter preview should contain binding info
    expect(view.getByText(/binding_create/)).toBeInTheDocument();
  });

  it('hides preview when toggle is off', () => {
    vi.mocked(useAgentContextConfig).mockReturnValue({
      config: { relayTools: false, meshTools: true, adapterTools: true, tasksTools: true },
      updateConfig: vi.fn(),
    });
    const view = renderTab();
    // Relay preview should be hidden
    expect(
      view.queryByText(new RegExp(escapeRegExp(AGENT_SUBJECT_FORMAT)))
    ).not.toBeInTheDocument();
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
      config: { relayTools: true, meshTools: true, adapterTools: true, tasksTools: true },
      updateConfig: vi.fn(),
    });
    const view = renderTab();
    // Relay and adapter previews should be hidden (feature unavailable)
    expect(view.queryByText(/relay\.agent\.\{agentId\}/)).not.toBeInTheDocument();
    expect(view.queryByText(/binding_create/)).not.toBeInTheDocument();
    // Mesh preview should show (always available)
    expect(view.getByText(/mesh_discover/)).toBeInTheDocument();
  });

  it('calls updateConfig when a toggle is switched', () => {
    const updateConfig = vi.fn();
    vi.mocked(useAgentContextConfig).mockReturnValue({
      config: { relayTools: true, meshTools: true, adapterTools: true, tasksTools: true },
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
      config: { relayTools: true, meshTools: true, adapterTools: true, tasksTools: true },
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

  // DOR-1337. These previews are a SECOND telling of blocks the server owns, and
  // the client cannot import server code to render the real ones — so the two
  // facts that made the first telling actively wrong are pinned here instead.
  describe('the previews teach what the runtime actually accepts', () => {
    it('shows the agent subject in the shape access rules match, never the two-segment one', () => {
      const view = renderTab();
      expect(view.getByText(new RegExp(escapeRegExp(AGENT_SUBJECT_FORMAT)))).toBeInTheDocument();
      // The shape that shipped for a release and matched no rule.
      expect(view.queryByText(/relay\.agent\.\{agentId\}/)).not.toBeInTheDocument();
    });

    it('names every tool the only way the runtime can call it', () => {
      const { container } = render(<ContextTab />);
      const text = container.textContent ?? '';
      const PREFIX = 'mcp__dorkos__';

      // Every DorkOS tool named in these previews must carry the prefix: a bare
      // name is not a tool at all on claude-code, and teaching one to a person
      // teaches it to their agent (DOR-1292). Scanned over the raw text, so a
      // name buried mid-line cannot slip past an element query.
      const unprefixed = [...text.matchAll(/(?:relay|mesh|binding)_[a-z_]+/g)]
        .filter(
          (match) => text.slice(Math.max(0, match.index - PREFIX.length), match.index) !== PREFIX
        )
        .map((match) => match[0]);

      expect(
        [...new Set(unprefixed)],
        'these tool names are written bare in an operator-facing preview'
      ).toEqual([]);
    });
  });
});
