import { describe, it, expect, beforeEach } from 'vitest';
import { useExtensionRegistry, createInitialSlots } from '@/layers/shared/model';
import { initializeExtensions } from '../init-extensions';

describe('initializeExtensions — right-panel contributions', () => {
  beforeEach(() => {
    // Reset the registry so each test sees a clean slot set.
    useExtensionRegistry.setState({ slots: createInitialSlots() });
    initializeExtensions();
  });

  function getRightPanelContribution(id: string) {
    const contributions = useExtensionRegistry.getState().getContributions('right-panel');
    return contributions.find((c) => c.id === id);
  }

  it('registers the Agent Profile (agent-hub) contribution', () => {
    expect(getRightPanelContribution('agent-hub')).toBeDefined();
  });

  it('hides the Agent Profile on the marketplace browse route', () => {
    const agentHub = getRightPanelContribution('agent-hub');
    // A visibleWhen predicate is required to keep the panel off /marketplace,
    // where it would otherwise default to a misleading "Agent not found" error.
    expect(agentHub?.visibleWhen).toBeDefined();
    expect(agentHub?.visibleWhen?.({ pathname: '/marketplace' })).toBe(false);
  });

  it('hides the Agent Profile on the marketplace sources route', () => {
    const agentHub = getRightPanelContribution('agent-hub');
    expect(agentHub?.visibleWhen?.({ pathname: '/marketplace/sources' })).toBe(false);
  });

  it('shows the Agent Profile on agent-context routes', () => {
    const agentHub = getRightPanelContribution('agent-hub');
    for (const pathname of ['/', '/session', '/agents', '/tasks', '/activity', '/workspaces']) {
      expect(agentHub?.visibleWhen?.({ pathname })).toBe(true);
    }
  });

  it('keeps the Canvas contribution scoped to the session route', () => {
    const canvas = getRightPanelContribution('canvas');
    expect(canvas?.visibleWhen?.({ pathname: '/session' })).toBe(true);
    expect(canvas?.visibleWhen?.({ pathname: '/marketplace' })).toBe(false);
  });
});
