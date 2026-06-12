import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('AppStore', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('toggleSidebar flips state', async () => {
    const { useAppStore } = await import('../app-store');
    expect(useAppStore.getState().sidebarOpen).toBe(false);

    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarOpen).toBe(true);

    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarOpen).toBe(false);
  });

  it('setSidebarOpen sets explicit value', async () => {
    const { useAppStore } = await import('../app-store');

    useAppStore.getState().setSidebarOpen(false);
    expect(useAppStore.getState().sidebarOpen).toBe(false);

    useAppStore.getState().setSidebarOpen(true);
    expect(useAppStore.getState().sidebarOpen).toBe(true);
  });

  it('sessionId defaults to null and can be set', async () => {
    const { useAppStore } = await import('../app-store');
    expect(useAppStore.getState().sessionId).toBeNull();

    useAppStore.getState().setSessionId('session-123');
    expect(useAppStore.getState().sessionId).toBe('session-123');

    useAppStore.getState().setSessionId(null);
    expect(useAppStore.getState().sessionId).toBeNull();
  });

  it('contextFiles starts empty', async () => {
    const { useAppStore } = await import('../app-store');
    expect(useAppStore.getState().contextFiles).toEqual([]);
  });

  it('addContextFile adds a file with generated id', async () => {
    const { useAppStore } = await import('../app-store');

    useAppStore.getState().addContextFile({ path: 'notes/test.md', basename: 'test' });
    const files = useAppStore.getState().contextFiles;
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('notes/test.md');
    expect(files[0].basename).toBe('test');
    expect(files[0].id).toBeTruthy();
  });

  it('addContextFile prevents duplicates by path', async () => {
    const { useAppStore } = await import('../app-store');

    useAppStore.getState().addContextFile({ path: 'notes/test.md', basename: 'test' });
    useAppStore.getState().addContextFile({ path: 'notes/test.md', basename: 'test' });
    expect(useAppStore.getState().contextFiles).toHaveLength(1);
  });

  it('removeContextFile removes by id', async () => {
    const { useAppStore } = await import('../app-store');

    useAppStore.getState().addContextFile({ path: 'a.md', basename: 'a' });
    useAppStore.getState().addContextFile({ path: 'b.md', basename: 'b' });
    const files = useAppStore.getState().contextFiles;
    expect(files).toHaveLength(2);

    useAppStore.getState().removeContextFile(files[0].id);
    expect(useAppStore.getState().contextFiles).toHaveLength(1);
    expect(useAppStore.getState().contextFiles[0].path).toBe('b.md');
  });

  it('clearContextFiles removes all', async () => {
    const { useAppStore } = await import('../app-store');

    useAppStore.getState().addContextFile({ path: 'a.md', basename: 'a' });
    useAppStore.getState().addContextFile({ path: 'b.md', basename: 'b' });
    expect(useAppStore.getState().contextFiles).toHaveLength(2);

    useAppStore.getState().clearContextFiles();
    expect(useAppStore.getState().contextFiles).toEqual([]);
  });

  it('defaults autoHideToolCalls to true', async () => {
    const { useAppStore } = await import('../app-store');
    expect(useAppStore.getState().autoHideToolCalls).toBe(true);
  });

  it('persists autoHideToolCalls to localStorage', async () => {
    const { useAppStore } = await import('../app-store');
    useAppStore.getState().setAutoHideToolCalls(false);
    expect(localStorage.getItem('dorkos-auto-hide-tool-calls')).toBe('false');
  });

  it('resets autoHideToolCalls to true on resetPreferences', async () => {
    const { useAppStore } = await import('../app-store');
    useAppStore.getState().setAutoHideToolCalls(false);
    useAppStore.getState().resetPreferences();
    expect(useAppStore.getState().autoHideToolCalls).toBe(true);
  });

  it('globalPaletteOpen defaults to false', async () => {
    const { useAppStore } = await import('../app-store');
    expect(useAppStore.getState().globalPaletteOpen).toBe(false);
  });

  it('setGlobalPaletteOpen sets explicit value', async () => {
    const { useAppStore } = await import('../app-store');
    useAppStore.getState().setGlobalPaletteOpen(true);
    expect(useAppStore.getState().globalPaletteOpen).toBe(true);
    useAppStore.getState().setGlobalPaletteOpen(false);
    expect(useAppStore.getState().globalPaletteOpen).toBe(false);
  });

  it('toggleGlobalPalette flips state', async () => {
    const { useAppStore } = await import('../app-store');
    expect(useAppStore.getState().globalPaletteOpen).toBe(false);
    useAppStore.getState().toggleGlobalPalette();
    expect(useAppStore.getState().globalPaletteOpen).toBe(true);
    useAppStore.getState().toggleGlobalPalette();
    expect(useAppStore.getState().globalPaletteOpen).toBe(false);
  });

  // Always-on-sync migration (spec chat-stream-reconnection, ADR-0266): the
  // retired "Multi-window sync" flag and its status-bar toggle leave orphaned
  // localStorage keys. Store creation purges them once on load.
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

  it('no longer exposes enableCrossClientSync on the store', async () => {
    const { useAppStore } = await import('../app-store');
    expect('enableCrossClientSync' in useAppStore.getState()).toBe(false);
    expect('setEnableCrossClientSync' in useAppStore.getState()).toBe(false);
  });

  it('defaults enableMessagePolling to false', async () => {
    const { useAppStore } = await import('../app-store');
    expect(useAppStore.getState().enableMessagePolling).toBe(false);
  });

  it('persists enableMessagePolling to localStorage', async () => {
    const { useAppStore } = await import('../app-store');
    useAppStore.getState().setEnableMessagePolling(true);
    expect(localStorage.getItem('dorkos-enable-message-polling')).toBe('true');
  });

  it('resets enableMessagePolling to false on resetPreferences', async () => {
    const { useAppStore } = await import('../app-store');
    useAppStore.getState().setEnableMessagePolling(true);
    useAppStore.getState().resetPreferences();
    expect(useAppStore.getState().enableMessagePolling).toBe(false);
  });
});
