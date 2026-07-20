import { describe, it, expect, vi, afterEach } from 'vitest';
import type { UiCommand } from '@dorkos/shared/types';
import type { ShapeLayout } from '@dorkos/shared/marketplace-schemas';
import { setPlatformAdapter } from '@/layers/shared/lib';
import { buildShapeLayoutCommands, applyShapeLayout } from '../lib/apply-shape-layout';

/** A minimal ShapeLayout with the fields under test. */
function layout(overrides: Partial<ShapeLayout> = {}): ShapeLayout {
  return {
    sidebarOpen: true,
    openPanels: [],
    focusDashboardSections: [],
    ...overrides,
  };
}

/** Point `getPlatform()` at an embedded (or not) host for the `applyShapeLayout` tests. */
function setEmbedded(isEmbedded: boolean) {
  setPlatformAdapter({ isEmbedded, openFile: async () => {} });
}

afterEach(() => {
  // Restore the default standalone-web adapter (isEmbedded: false).
  setEmbedded(false);
});

describe('buildShapeLayoutCommands', () => {
  it('emits switch_sidebar_tab when a tab strip exists, a tab is pinned, AND the sidebar is open', () => {
    // Purpose: the embedded (Obsidian) case — arrive on the overview tab with the
    // sidebar open. One command both opens and selects.
    const commands = buildShapeLayoutCommands(
      layout({ sidebarOpen: true, sidebarTab: 'overview' }),
      true
    );
    expect(commands).toContainEqual({ action: 'switch_sidebar_tab', tab: 'overview' });
    // It must not ALSO emit a bare open — the tab switch already opens the sidebar.
    expect(commands).not.toContainEqual({ action: 'open_sidebar' });
  });

  it('drops the pinned tab and just opens the sidebar where no tab strip exists (web cockpit)', () => {
    // The web cockpit has no sidebar tab strip, so a pinned tab has no target;
    // the sidebar must still honor `sidebarOpen` via a plain open command.
    const commands = buildShapeLayoutCommands(
      layout({ sidebarOpen: true, sidebarTab: 'overview' }),
      false
    );
    expect(commands).toEqual([{ action: 'open_sidebar' }]);
    expect(commands).not.toContainEqual({ action: 'switch_sidebar_tab', tab: 'overview' });
  });

  it('carries an extension-namespaced pinned tab id verbatim when a strip exists', () => {
    const commands = buildShapeLayoutCommands(
      layout({ sidebarOpen: true, sidebarTab: 'linear-issues:linear-loop-sidebar' }),
      true
    );
    expect(commands).toContainEqual({
      action: 'switch_sidebar_tab',
      tab: 'linear-issues:linear-loop-sidebar',
    });
  });

  it('emits open_sidebar when open with no pinned tab', () => {
    expect(buildShapeLayoutCommands(layout({ sidebarOpen: true }), true)).toEqual([
      { action: 'open_sidebar' },
    ]);
  });

  it('emits close_sidebar when closed, and never force-opens via a tab switch', () => {
    // Purpose: a closed-sidebar Shape must stay closed even if it names a tab.
    const commands = buildShapeLayoutCommands(
      layout({ sidebarOpen: false, sidebarTab: 'sessions' }),
      true
    );
    expect(commands).toEqual([{ action: 'close_sidebar' }]);
  });

  it('opens each requested panel in order after the sidebar command', () => {
    const commands = buildShapeLayoutCommands(
      layout({ sidebarOpen: true, openPanels: ['tasks', 'settings'] }),
      true
    );
    expect(commands).toEqual([
      { action: 'open_sidebar' },
      { action: 'open_panel', panel: 'tasks' },
      { action: 'open_panel', panel: 'settings' },
    ]);
  });

  it('emits no command for focusDashboardSections (ordering hint, no client store today)', () => {
    // Purpose: the hint must not fabricate a command — it degrades to nothing.
    const commands = buildShapeLayoutCommands(
      layout({
        sidebarOpen: false,
        focusDashboardSections: ['linear-issues:linear-loop-dashboard'],
      }),
      true
    );
    expect(commands).toEqual([{ action: 'close_sidebar' }]);
  });
});

describe('applyShapeLayout', () => {
  it('dispatches a tab switch on the embedded host', () => {
    setEmbedded(true);
    const dispatched: UiCommand[] = [];
    applyShapeLayout(
      layout({ sidebarOpen: true, sidebarTab: 'overview', openPanels: ['tasks'] }),
      (c) => dispatched.push(c)
    );
    expect(dispatched).toEqual([
      { action: 'switch_sidebar_tab', tab: 'overview' },
      { action: 'open_panel', panel: 'tasks' },
    ]);
  });

  it('opens the sidebar without a tab switch on the web cockpit', () => {
    setEmbedded(false);
    const dispatched: UiCommand[] = [];
    applyShapeLayout(
      layout({ sidebarOpen: true, sidebarTab: 'overview', openPanels: ['tasks'] }),
      (c) => dispatched.push(c)
    );
    expect(dispatched).toEqual([
      { action: 'open_sidebar' },
      { action: 'open_panel', panel: 'tasks' },
    ]);
  });

  it('is a no-op-safe pass-through — dispatch is called exactly once per command', () => {
    const dispatch = vi.fn();
    applyShapeLayout(layout({ sidebarOpen: false }), dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
