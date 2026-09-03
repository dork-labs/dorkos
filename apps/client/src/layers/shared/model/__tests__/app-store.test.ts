import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../app-store';

// The store is imported ONCE, at file load, and each test restores this snapshot
// instead of re-importing the module (DOR-1164). The old shape called
// `vi.resetModules()` + `await import('../app-store')` in every test, so the
// module graph was re-executed 20 times inside test bodies; the first test paid
// the cold transform (measured 5011ms against the 5000ms default `testTimeout`)
// and the file flaked on any loaded machine.
//
// The snapshot is taken before any test runs, with localStorage untouched, so it
// holds exactly the defaults the store computes on a clean load — the assertions
// below ("defaults to null", "starts empty", "defaults autoHideToolCalls to
// true") are what keep that claim honest. Restoring it is what protects those
// defaults; clearing localStorage protects the two `localStorage.getItem`
// assertions and the load-time-migration describe further down, which reads
// storage that a previous test wrote.
//
// The snapshot is frozen and restored as a fresh copy: `setState(snapshot, true)`
// would make live state identity-equal to it, so one future in-place mutation
// would poison the snapshot and every later restore would silently restore
// nothing. Freezing turns that mistake into a loud failure instead.
const INITIAL_STATE = Object.freeze(useAppStore.getState());

describe('AppStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ ...INITIAL_STATE }, true);
  });

  it('toggleSidebar flips state', () => {
    // Desktop default is open (DOR-343); jsdom matchMedia reports non-mobile.
    expect(useAppStore.getState().sidebarOpen).toBe(true);

    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarOpen).toBe(false);

    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarOpen).toBe(true);
  });

  it('setSidebarOpen sets explicit value', () => {
    useAppStore.getState().setSidebarOpen(false);
    expect(useAppStore.getState().sidebarOpen).toBe(false);

    useAppStore.getState().setSidebarOpen(true);
    expect(useAppStore.getState().sidebarOpen).toBe(true);
  });

  it('sessionId defaults to null and can be set', () => {
    expect(useAppStore.getState().sessionId).toBeNull();

    useAppStore.getState().setSessionId('session-123');
    expect(useAppStore.getState().sessionId).toBe('session-123');

    useAppStore.getState().setSessionId(null);
    expect(useAppStore.getState().sessionId).toBeNull();
  });

  it('contextFiles starts empty', () => {
    expect(useAppStore.getState().contextFiles).toEqual([]);
  });

  it('addContextFile adds a file with generated id', () => {
    useAppStore.getState().addContextFile({ path: 'notes/test.md', basename: 'test' });
    const files = useAppStore.getState().contextFiles;
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('notes/test.md');
    expect(files[0].basename).toBe('test');
    expect(files[0].id).toBeTruthy();
  });

  it('addContextFile prevents duplicates by path', () => {
    useAppStore.getState().addContextFile({ path: 'notes/test.md', basename: 'test' });
    useAppStore.getState().addContextFile({ path: 'notes/test.md', basename: 'test' });
    expect(useAppStore.getState().contextFiles).toHaveLength(1);
  });

  it('removeContextFile removes by id', () => {
    useAppStore.getState().addContextFile({ path: 'a.md', basename: 'a' });
    useAppStore.getState().addContextFile({ path: 'b.md', basename: 'b' });
    const files = useAppStore.getState().contextFiles;
    expect(files).toHaveLength(2);

    useAppStore.getState().removeContextFile(files[0].id);
    expect(useAppStore.getState().contextFiles).toHaveLength(1);
    expect(useAppStore.getState().contextFiles[0].path).toBe('b.md');
  });

  it('clearContextFiles removes all', () => {
    useAppStore.getState().addContextFile({ path: 'a.md', basename: 'a' });
    useAppStore.getState().addContextFile({ path: 'b.md', basename: 'b' });
    expect(useAppStore.getState().contextFiles).toHaveLength(2);

    useAppStore.getState().clearContextFiles();
    expect(useAppStore.getState().contextFiles).toEqual([]);
  });

  it('defaults autoHideToolCalls to true', () => {
    expect(useAppStore.getState().autoHideToolCalls).toBe(true);
  });

  it('sets autoHideToolCalls on the store', () => {
    useAppStore.getState().setAutoHideToolCalls(false);
    expect(useAppStore.getState().autoHideToolCalls).toBe(false);
  });

  it('persists autoHideToolCalls to localStorage', () => {
    useAppStore.getState().setAutoHideToolCalls(false);
    expect(localStorage.getItem('dorkos-auto-hide-tool-calls')).toBe('false');
  });

  it('resets autoHideToolCalls to true on resetAllSettings', () => {
    useAppStore.getState().setAutoHideToolCalls(false);
    expect(useAppStore.getState().autoHideToolCalls).toBe(false);

    useAppStore.getState().resetAllSettings();
    expect(useAppStore.getState().autoHideToolCalls).toBe(true);
  });

  it('globalPaletteOpen defaults to false', () => {
    expect(useAppStore.getState().globalPaletteOpen).toBe(false);
  });

  it('setGlobalPaletteOpen sets explicit value', () => {
    useAppStore.getState().setGlobalPaletteOpen(true);
    expect(useAppStore.getState().globalPaletteOpen).toBe(true);
    useAppStore.getState().setGlobalPaletteOpen(false);
    expect(useAppStore.getState().globalPaletteOpen).toBe(false);
  });

  it('toggleGlobalPalette flips state', () => {
    expect(useAppStore.getState().globalPaletteOpen).toBe(false);
    useAppStore.getState().toggleGlobalPalette();
    expect(useAppStore.getState().globalPaletteOpen).toBe(true);
    useAppStore.getState().toggleGlobalPalette();
    expect(useAppStore.getState().globalPaletteOpen).toBe(false);
  });

  it('no longer exposes enableCrossClientSync on the store', () => {
    expect('enableCrossClientSync' in useAppStore.getState()).toBe(false);
    expect('setEnableCrossClientSync' in useAppStore.getState()).toBe(false);
  });

  it('defaults enableMessagePolling to false', () => {
    expect(useAppStore.getState().enableMessagePolling).toBe(false);
  });

  it('sets enableMessagePolling on the store', () => {
    useAppStore.getState().setEnableMessagePolling(true);
    expect(useAppStore.getState().enableMessagePolling).toBe(true);
  });

  it('persists enableMessagePolling to localStorage', () => {
    useAppStore.getState().setEnableMessagePolling(true);
    expect(localStorage.getItem('dorkos-enable-message-polling')).toBe('true');
  });

  it('resets enableMessagePolling to false on resetAllSettings', () => {
    useAppStore.getState().setEnableMessagePolling(true);
    expect(useAppStore.getState().enableMessagePolling).toBe(true);

    useAppStore.getState().resetAllSettings();
    expect(useAppStore.getState().enableMessagePolling).toBe(false);
  });
});

// Always-on-sync migration (spec chat-stream-reconnection, ADR-0266): the
// retired "Multi-window sync" flag and its status-bar toggle leave orphaned
// localStorage keys. Store creation purges them once on load.
//
// These two are the only tests in this file that re-import the module, and they
// have to: the purge is a module-level side effect that runs when the graph is
// evaluated, so no amount of `setState` can replay it. Re-importing here (and
// nowhere else) keeps the check honest while costing two module evaluations
// instead of twenty (DOR-1164). The store the rest of the file holds is a
// different instance from the one these create; neither touches the other's
// state, only localStorage, which every `beforeEach` clears.
describe('AppStore — load-time migration (needs a fresh module graph)', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('purges the stale cross-client-sync localStorage keys on load when present', async () => {
    localStorage.setItem('dorkos-enable-cross-client-sync', 'true');
    localStorage.setItem('dorkos-show-status-bar-sync', 'true');

    // Importing the store module runs the one-time migration.
    await import('../app-store');

    expect(localStorage.getItem('dorkos-enable-cross-client-sync')).toBeNull();
    expect(localStorage.getItem('dorkos-show-status-bar-sync')).toBeNull();
  });

  it('migration is a no-op when the stale keys are absent (no throw)', async () => {
    // No stale keys set; importing the store must not throw and must not
    // resurrect the keys.
    await expect(import('../app-store')).resolves.toBeDefined();
    expect(localStorage.getItem('dorkos-enable-cross-client-sync')).toBeNull();
    expect(localStorage.getItem('dorkos-show-status-bar-sync')).toBeNull();
  });
});
