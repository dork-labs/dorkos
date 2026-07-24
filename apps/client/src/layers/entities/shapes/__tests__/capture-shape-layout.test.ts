/**
 * Tests for {@link captureShapeLayout} (DOR-402) — the chrome snapshot a
 * capture-current fork sends as `liveLayout`.
 *
 * The important one is the round trip: capture must be the inverse of
 * {@link buildShapeLayoutCommands}, so a fork of the Shape you are living in
 * replays the arrangement you were living in.
 */
import { describe, it, expect } from 'vitest';
import type { ShapeLayout } from '@dorkos/shared/marketplace-schemas';
import { buildShapeLayoutCommands } from '../lib/apply-shape-layout';
import { captureShapeLayout, type LiveChromeSnapshot } from '../lib/capture-shape-layout';

/** Live chrome with everything closed, overridden per test. */
function chrome(overrides: Partial<LiveChromeSnapshot> = {}): LiveChromeSnapshot {
  return {
    sidebarOpen: false,
    settingsOpen: false,
    tasksOpen: false,
    relayOpen: false,
    pickerOpen: false,
    ...overrides,
  };
}

/**
 * The server's field-wise merge (`mergeLayout` in `services/shapes/fork.ts`):
 * a field the capture omits keeps the source Shape's value. Reproduced here so
 * the round trip runs against the layout the fork actually stores.
 */
function mergeOverSource(source: ShapeLayout, capture: Partial<ShapeLayout>): ShapeLayout {
  return {
    sidebarOpen: capture.sidebarOpen ?? source.sidebarOpen,
    sidebarTab: capture.sidebarTab ?? source.sidebarTab,
    openPanels: capture.openPanels ?? source.openPanels,
    focusDashboardSections: capture.focusDashboardSections ?? source.focusDashboardSections,
  };
}

describe('captureShapeLayout', () => {
  it('captures the sidebar state and every open panel', () => {
    expect(
      captureShapeLayout(chrome({ sidebarOpen: true, tasksOpen: true, pickerOpen: true }))
    ).toEqual({ sidebarOpen: true, openPanels: ['tasks', 'picker'] });
  });

  it('reports an empty panel list when nothing is open, never omits the field', () => {
    // An empty list is a real observation ("no panels open") — omitting it would
    // make the fork inherit the source Shape's panels instead.
    expect(captureShapeLayout(chrome({ sidebarOpen: false }))).toEqual({
      sidebarOpen: false,
      openPanels: [],
    });
  });

  it('omits sidebarTab and focusDashboardSections — nothing observable backs them', () => {
    // The web cockpit retired its sidebar tab strip (DOR-401) and has no state at
    // all behind focusDashboardSections. Reporting either would write a value the
    // user never chose over the source Shape's.
    const capture = captureShapeLayout(chrome({ sidebarOpen: true, settingsOpen: true }));
    expect(capture).not.toHaveProperty('sidebarTab');
    expect(capture).not.toHaveProperty('focusDashboardSections');
  });

  it('round-trips: capture → fork merge → buildShapeLayoutCommands replays what was captured', () => {
    const live = chrome({ sidebarOpen: true, settingsOpen: true, relayOpen: true });
    const source: ShapeLayout = {
      // Deliberately the opposite of the live chrome, so a failure to capture
      // would show up as the source's arrangement coming back instead.
      sidebarOpen: false,
      openPanels: ['picker'],
      focusDashboardSections: ['linear-issues:board'],
    };

    const forked = mergeOverSource(source, captureShapeLayout(live));

    // The web cockpit has no tab strip, so this is the honest replay path.
    expect(buildShapeLayoutCommands(forked, false)).toEqual([
      { action: 'open_sidebar' },
      { action: 'open_panel', panel: 'settings' },
      { action: 'open_panel', panel: 'relay' },
    ]);
    // The field nobody observed rode through untouched.
    expect(forked.focusDashboardSections).toEqual(['linear-issues:board']);
  });

  it('round-trips a fully closed arrangement', () => {
    const source: ShapeLayout = {
      sidebarOpen: true,
      openPanels: ['settings', 'tasks'],
      focusDashboardSections: [],
    };

    const forked = mergeOverSource(source, captureShapeLayout(chrome()));

    expect(buildShapeLayoutCommands(forked, false)).toEqual([{ action: 'close_sidebar' }]);
  });
});
