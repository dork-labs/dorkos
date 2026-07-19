import { describe, it, expect, vi } from 'vitest';
import type { UiCommand } from '@dorkos/shared/types';
import type { ShapeLayout } from '@dorkos/shared/marketplace-schemas';
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

describe('buildShapeLayoutCommands', () => {
  it('emits switch_sidebar_tab when a tab is pinned AND the sidebar is open (one command opens + selects)', () => {
    // Purpose: the Linear Ops case — arrive on the overview tab with the sidebar open.
    const commands = buildShapeLayoutCommands(
      layout({ sidebarOpen: true, sidebarTab: 'overview' })
    );
    expect(commands).toContainEqual({ action: 'switch_sidebar_tab', tab: 'overview' });
    // It must not ALSO emit a bare open — the tab switch already opens the sidebar.
    expect(commands).not.toContainEqual({ action: 'open_sidebar' });
  });

  it('emits switch_sidebar_tab for an extension-contributed tab id', () => {
    // A Shape may pin an extension tab (`${extId}:${id}`); the command carries
    // it verbatim to the dispatcher, which the store + sidebar resolve.
    const commands = buildShapeLayoutCommands(
      layout({ sidebarOpen: true, sidebarTab: 'linear-issues:linear-loop-sidebar' })
    );
    expect(commands).toContainEqual({
      action: 'switch_sidebar_tab',
      tab: 'linear-issues:linear-loop-sidebar',
    });
  });

  it('emits open_sidebar when open with no pinned tab', () => {
    expect(buildShapeLayoutCommands(layout({ sidebarOpen: true }))).toEqual([
      { action: 'open_sidebar' },
    ]);
  });

  it('emits close_sidebar when closed, and never force-opens via a tab switch', () => {
    // Purpose: a closed-sidebar Shape must stay closed even if it names a tab.
    const commands = buildShapeLayoutCommands(
      layout({ sidebarOpen: false, sidebarTab: 'sessions' })
    );
    expect(commands).toEqual([{ action: 'close_sidebar' }]);
  });

  it('opens each requested panel in order after the sidebar command', () => {
    const commands = buildShapeLayoutCommands(
      layout({ sidebarOpen: true, openPanels: ['tasks', 'settings'] })
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
      })
    );
    expect(commands).toEqual([{ action: 'close_sidebar' }]);
  });
});

describe('applyShapeLayout', () => {
  it('dispatches every built command, in order', () => {
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

  it('is a no-op-safe pass-through — dispatch is called exactly once per command', () => {
    const dispatch = vi.fn();
    applyShapeLayout(layout({ sidebarOpen: false }), dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
