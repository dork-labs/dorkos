import { describe, it, expect, beforeEach } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
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

  it('registers Pulse as an always-present global tab', () => {
    const pulse = getRightPanelContribution('pulse');
    expect(pulse).toBeDefined();
    // No visibleWhen — Pulse shows on every route (the global spine).
    expect(pulse?.visibleWhen).toBeUndefined();
    // isGlobal marks it the no-selection fallback for the default-tab rule.
    expect(pulse?.isGlobal).toBe(true);
  });

  it('sorts Pulse first — its priority is below every contextual tab', () => {
    const contributions = useExtensionRegistry.getState().getContributions('right-panel');
    const pulse = contributions.find((c) => c.id === 'pulse');
    const contextual = contributions.filter((c) => c.id !== 'pulse');
    expect(contextual.length).toBeGreaterThan(0);
    for (const c of contextual) {
      expect(pulse!.priority!).toBeLessThan(c.priority!);
    }
  });

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

  it('always shows the Agent Profile on the session route', () => {
    const agentHub = getRightPanelContribution('agent-hub');
    // /session profiles the session's own agent — no explicit pick required.
    expect(agentHub?.visibleWhen?.({ pathname: '/session' })).toBe(true);
    expect(agentHub?.visibleWhen?.({ pathname: '/session', explicitAgentPath: null })).toBe(true);
  });

  it('hides the Agent Profile off /session until an agent is explicitly opened', () => {
    const agentHub = getRightPanelContribution('agent-hub');
    // Selection-honest: with no explicit selection, the ambient startup agent
    // must NOT surface on the dashboard/activity/tasks/workspaces routes.
    for (const pathname of ['/', '/agents', '/tasks', '/activity', '/workspaces']) {
      expect(agentHub?.visibleWhen?.({ pathname, explicitAgentPath: null })).toBe(false);
    }
  });

  it('shows the Agent Profile off /session once an agent is explicitly opened', () => {
    const agentHub = getRightPanelContribution('agent-hub');
    for (const pathname of ['/', '/agents', '/tasks', '/activity', '/workspaces']) {
      expect(agentHub?.visibleWhen?.({ pathname, explicitAgentPath: '/repo/a' })).toBe(true);
    }
  });

  it('keeps the Agent Profile hidden on marketplace even with an explicit selection', () => {
    const agentHub = getRightPanelContribution('agent-hub');
    expect(
      agentHub?.visibleWhen?.({ pathname: '/marketplace', explicitAgentPath: '/repo/a' })
    ).toBe(false);
  });

  it('registers the Files contribution', () => {
    expect(getRightPanelContribution('files')).toBeDefined();
  });

  it('scopes the Files tab to the session route', () => {
    const files = getRightPanelContribution('files');
    expect(files?.visibleWhen?.({ pathname: '/session' })).toBe(true);
    for (const pathname of ['/', '/agents', '/tasks', '/marketplace']) {
      expect(files?.visibleWhen?.({ pathname })).toBe(false);
    }
  });

  it('shows the Files tab under both transports (not gated on a web-only capability)', () => {
    const files = getRightPanelContribution('files');
    // The file service works under DirectTransport too, so the tab must not be
    // hidden the way the web-only terminal is.
    const directTransport = createMockTransport({ supportsTerminal: false });
    expect(files?.visibleWhen?.({ pathname: '/session', transport: directTransport })).toBe(true);
  });

  it('orders the Files tab (priority 15) between Agent Profile (10) and Canvas (20)', () => {
    expect(getRightPanelContribution('files')?.priority).toBe(15);
  });

  it('keeps the Canvas contribution scoped to the session route', () => {
    const canvas = getRightPanelContribution('canvas');
    expect(canvas?.visibleWhen?.({ pathname: '/session' })).toBe(true);
    expect(canvas?.visibleWhen?.({ pathname: '/marketplace' })).toBe(false);
  });

  it('registers the Terminal contribution', () => {
    expect(getRightPanelContribution('terminal')).toBeDefined();
  });

  it('shows the Terminal tab on /session under a terminal-capable (HTTP) transport', () => {
    const terminal = getRightPanelContribution('terminal');
    // HttpTransport reports supportsTerminal: true — the web-only tab is shown.
    const httpTransport = createMockTransport({ supportsTerminal: true });
    expect(terminal?.visibleWhen?.({ pathname: '/session', transport: httpTransport })).toBe(true);
  });

  it('hides the Terminal tab under the in-process (Direct/Obsidian) transport', () => {
    const terminal = getRightPanelContribution('terminal');
    // DirectTransport reports supportsTerminal: false — the tab must be hidden.
    const directTransport = createMockTransport({ supportsTerminal: false });
    expect(terminal?.visibleWhen?.({ pathname: '/session', transport: directTransport })).toBe(
      false
    );
  });

  it('hides the Terminal tab off the session route even when supported', () => {
    const terminal = getRightPanelContribution('terminal');
    const httpTransport = createMockTransport({ supportsTerminal: true });
    for (const pathname of ['/', '/agents', '/tasks', '/marketplace']) {
      expect(terminal?.visibleWhen?.({ pathname, transport: httpTransport })).toBe(false);
    }
  });
});
