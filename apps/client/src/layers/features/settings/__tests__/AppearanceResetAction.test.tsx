// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useAppStore, useThemeStore } from '@/layers/shared/model';
import { DEFAULT_FONT } from '@/layers/shared/lib';
import { AppearanceResetAction } from '../ui/tabs/AppearanceTab';

const CANVAS_SESSIONS = {
  'session-1': { open: true, documents: [], activeDocumentId: null, accessedAt: 1 },
};
const RIGHT_PANEL_LAYOUTS = {
  'agent-1': { open: true, activeTab: 'profile', accessedAt: 1 },
};
const RIGHT_PANEL_STATE = { open: true, activeTab: 'profile' };

/**
 * Put every slice into a clearly non-default state, driving the real setters so
 * localStorage is written the way the app writes it. The canvas and right-panel
 * surfaces are seeded as raw storage because that is the shape their readers
 * parse, and what matters here is that a reset does not delete them.
 */
function seedNonDefaultState() {
  const s = useAppStore.getState();
  s.setShowTimestamps(true);
  s.setExpandToolCalls(true);
  s.setAutoHideToolCalls(false);
  s.setPromoEnabled(false);
  s.setSidebarActiveTab('connections');
  s.setPipGeometry({ x: 1, y: 2, width: 300, height: 200 });
  s.openPip({ kind: 'demo', title: 'Demo panel' });
  localStorage.setItem('dorkos-canvas-sessions', JSON.stringify(CANVAS_SESSIONS));
  localStorage.setItem('dorkos-right-panel-layouts', JSON.stringify(RIGHT_PANEL_LAYOUTS));
  localStorage.setItem('dorkos-right-panel-state', JSON.stringify(RIGHT_PANEL_STATE));
  localStorage.setItem('dorkos-dismissed-promo-ids', '["welcome"]');

  // Appearance — the only thing this button is allowed to touch.
  s.setFontSize('large');
  s.setFontFamily('geist');
  useThemeStore.getState().setTheme('dark');
}

describe('AppearanceResetAction', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.getState().resetAllSettings();
    useThemeStore.getState().setTheme('system');
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  function clickReset() {
    render(<AppearanceResetAction />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
  }

  it('puts theme and typography back to their defaults', () => {
    seedNonDefaultState();

    clickReset();

    expect(useThemeStore.getState().theme).toBe('system');
    expect(useAppStore.getState().fontSize).toBe('medium');
    expect(useAppStore.getState().fontFamily).toBe(DEFAULT_FONT);
    expect(localStorage.getItem('dorkos-font-size')).toBeNull();
    expect(localStorage.getItem('dorkos-font-family')).toBeNull();
  });

  it('leaves the Preferences tab toggles alone, in state and in storage', () => {
    seedNonDefaultState();

    clickReset();

    const s = useAppStore.getState();
    expect(s.showTimestamps).toBe(true);
    expect(s.expandToolCalls).toBe(true);
    expect(s.autoHideToolCalls).toBe(false);
    expect(s.promoEnabled).toBe(false);
    expect(localStorage.getItem('dorkos-show-timestamps')).toBe('true');
    expect(localStorage.getItem('dorkos-expand-tool-calls')).toBe('true');
    expect(localStorage.getItem('dorkos-auto-hide-tool-calls')).toBe('false');
    expect(localStorage.getItem('dorkos-promo-enabled')).toBe('false');
  });

  it('leaves the sidebar, canvas, right-panel, PIP and promo-dismissal state alone', () => {
    seedNonDefaultState();

    clickReset();

    const s = useAppStore.getState();
    expect(s.sidebarActiveTab).toBe('connections');
    expect(s.pipGeometry).toEqual({ x: 1, y: 2, width: 300, height: 200 });
    expect(s.pipContent).toEqual({ kind: 'demo', title: 'Demo panel' });
    expect(localStorage.getItem('dorkos-sidebar-active-tab')).toBe('connections');
    expect(JSON.parse(localStorage.getItem('dorkos-canvas-sessions')!)).toEqual(CANVAS_SESSIONS);
    expect(JSON.parse(localStorage.getItem('dorkos-right-panel-layouts')!)).toEqual(
      RIGHT_PANEL_LAYOUTS
    );
    expect(JSON.parse(localStorage.getItem('dorkos-right-panel-state')!)).toEqual(
      RIGHT_PANEL_STATE
    );
    expect(localStorage.getItem('dorkos-pip-panel-state')).not.toBeNull();
    expect(localStorage.getItem('dorkos-dismissed-promo-ids')).toBe('["welcome"]');
  });
});
