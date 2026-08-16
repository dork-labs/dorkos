import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import {
  useExtensionRegistry,
  createInitialSlots,
  isExtensionContributionId,
} from '@/layers/shared/model';
import { setPlatformAdapter } from '@/layers/shared/lib';
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

  it('registers the Profile contribution, under that name', () => {
    const profile = getRightPanelContribution('profile');
    expect(profile).toBeDefined();
    // The tab reads "Profile", not "Agent Profile" and not "Agent Hub": one
    // surface, one word (spec `profile-unification` D9). Pinned because the
    // strip's label is the whole of what a person sees of this registration.
    expect(profile?.title).toBe('Profile');
    // Nothing may register under the old id — a second contribution would put
    // two profile tabs in the strip.
    expect(getRightPanelContribution('agent-hub')).toBeUndefined();
  });

  it('hides the Profile on the marketplace browse route', () => {
    const profile = getRightPanelContribution('profile');
    // A visibleWhen predicate is required to keep the panel off /marketplace,
    // where it would otherwise default to a misleading "Agent not found" error.
    expect(profile?.visibleWhen).toBeDefined();
    expect(profile?.visibleWhen?.({ pathname: '/marketplace' })).toBe(false);
  });

  it('hides the Profile on the marketplace sources route', () => {
    const profile = getRightPanelContribution('profile');
    expect(profile?.visibleWhen?.({ pathname: '/marketplace/sources' })).toBe(false);
  });

  it('always shows the Profile on the session route', () => {
    const profile = getRightPanelContribution('profile');
    // /session profiles the session's own agent — no explicit pick required.
    expect(profile?.visibleWhen?.({ pathname: '/session' })).toBe(true);
    expect(profile?.visibleWhen?.({ pathname: '/session', explicitAgentPath: null })).toBe(true);
  });

  it('hides the Profile off /session until an agent is explicitly opened', () => {
    const profile = getRightPanelContribution('profile');
    // Selection-honest: with no explicit selection, the ambient startup agent
    // must NOT surface on the dashboard/activity/tasks/workspaces routes.
    for (const pathname of ['/', '/team', '/tasks', '/activity', '/workspaces']) {
      expect(profile?.visibleWhen?.({ pathname, explicitAgentPath: null })).toBe(false);
    }
  });

  it('shows the Profile off /session once an agent is explicitly opened', () => {
    const profile = getRightPanelContribution('profile');
    for (const pathname of ['/', '/team', '/tasks', '/activity', '/workspaces']) {
      expect(profile?.visibleWhen?.({ pathname, explicitAgentPath: '/repo/a' })).toBe(true);
    }
  });

  it('keeps the Profile hidden on marketplace even with an explicit selection', () => {
    const profile = getRightPanelContribution('profile');
    expect(profile?.visibleWhen?.({ pathname: '/marketplace', explicitAgentPath: '/repo/a' })).toBe(
      false
    );
  });

  it('registers the Files contribution', () => {
    expect(getRightPanelContribution('files')).toBeDefined();
  });

  it('scopes the Files tab to the session route', () => {
    const files = getRightPanelContribution('files');
    expect(files?.visibleWhen?.({ pathname: '/session' })).toBe(true);
    for (const pathname of ['/', '/team', '/tasks', '/marketplace']) {
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
    for (const pathname of ['/', '/team', '/tasks', '/marketplace']) {
      expect(terminal?.visibleWhen?.({ pathname, transport: httpTransport })).toBe(false);
    }
  });
});

describe('initializeExtensions — command palette gating (Obsidian embed)', () => {
  // Built-ins that need AppShell chrome the embed never renders: a mounted
  // dialog (Create Agent / Import), the right panel (Agent Profile, Canvas), or
  // the router (Dashboard, Agents — navigate() throws with no RouterProvider).
  const EMBED_DEAD_ENDS = [
    'createAgent',
    'discoverAgents',
    'openAgentProfile',
    'toggleCanvas',
    'navigateDashboard',
    'openMesh',
  ];

  function paletteActions(): string[] {
    return useExtensionRegistry
      .getState()
      .getContributions('command-palette.items')
      .map((c) => (c as { action?: string }).action ?? '');
  }

  function initWith(isEmbedded: boolean): void {
    setPlatformAdapter({ isEmbedded, openFile: async () => {} });
    useExtensionRegistry.setState({ slots: createInitialSlots() });
    initializeExtensions();
  }

  afterEach(() => {
    // Restore the standalone-web adapter so other suites see the default.
    setPlatformAdapter({ isEmbedded: false, openFile: async () => {} });
  });

  it('registers the full router/panel-dependent set on the web shell', () => {
    initWith(false);

    const actions = paletteActions();
    for (const action of EMBED_DEAD_ENDS) {
      expect(actions).toContain(action);
    }
  });

  it('omits every dead-end from the Obsidian embed, keeping the rest', () => {
    // Defensive gate: the embed does not currently call initializeExtensions, but
    // if it ever does, none of these dialog/panel/router actions may register —
    // acting on them there renders nothing or throws.
    initWith(true);

    const actions = paletteActions();
    for (const action of EMBED_DEAD_ENDS) {
      expect(actions).not.toContain(action);
    }
    // The gate is selective — a self-contained action (theme toggle) still registers.
    expect(actions).toContain('toggleTheme');
  });
});

describe('initializeExtensions — built-in ids never look like extension ids', () => {
  beforeEach(() => {
    useExtensionRegistry.setState({ slots: createInitialSlots() });
    setPlatformAdapter({ isEmbedded: false, openFile: async () => {} });
    initializeExtensions();
  });

  it('registers no colon-bearing id in any slot before an extension loads', () => {
    // `isExtensionContributionId` tells first-party contributions apart from
    // extension ones by the `${extensionId}:${localId}` namespace the extension
    // API stamps on. Two surfaces split the `dashboard.sections` slot on that
    // rule, so a built-in id with a colon in it would silently move a first-party
    // section onto the Activity tab's "From your extensions" group. This walks
    // every slot, including the ones registered inline in init-extensions rather
    // than from an exported contribution list.
    const { slots } = useExtensionRegistry.getState();
    const offenders: string[] = [];
    for (const [slotId, contributions] of Object.entries(slots)) {
      for (const contribution of contributions) {
        if (isExtensionContributionId(contribution.id)) {
          offenders.push(`${slotId}/${contribution.id}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('registered something in every slot it walks — the check is not vacuous', () => {
    const { slots } = useExtensionRegistry.getState();
    const total = Object.values(slots).reduce((sum, list) => sum + list.length, 0);
    expect(total).toBeGreaterThan(0);
  });
});
