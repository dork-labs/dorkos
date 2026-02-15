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
    expect(localStorage.getItem('gateway-auto-hide-tool-calls')).toBe('false');
  });

  it('resets autoHideToolCalls to true on resetPreferences', async () => {
    const { useAppStore } = await import('../app-store');
    useAppStore.getState().setAutoHideToolCalls(false);
    useAppStore.getState().resetPreferences();
    expect(useAppStore.getState().autoHideToolCalls).toBe(true);
  });
});
