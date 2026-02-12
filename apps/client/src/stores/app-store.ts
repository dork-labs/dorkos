import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

export interface ContextFile {
  id: string;
  path: string;
  basename: string;
}

export interface RecentCwd {
  path: string;
  accessedAt: string;
}

interface AppState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;

  sessionId: string | null;
  setSessionId: (id: string | null) => void;

  selectedCwd: string | null;
  setSelectedCwd: (cwd: string) => void;

  recentCwds: RecentCwd[];

  contextFiles: ContextFile[];
  addContextFile: (file: Omit<ContextFile, 'id'>) => void;
  removeContextFile: (id: string) => void;
  clearContextFiles: () => void;
}

export const useAppStore = create<AppState>()(devtools((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  sessionId: null,
  setSessionId: (id) => set({ sessionId: id }),

  selectedCwd: null,
  setSelectedCwd: (cwd) =>
    set((s) => {
      const entry: RecentCwd = { path: cwd, accessedAt: new Date().toISOString() };
      const recents = [entry, ...s.recentCwds.filter((r) => r.path !== cwd)].slice(0, 10);
      try { localStorage.setItem('gateway-recent-cwds', JSON.stringify(recents)); } catch {}
      return { selectedCwd: cwd, recentCwds: recents };
    }),

  recentCwds: (() => {
    try {
      const raw: unknown[] = JSON.parse(localStorage.getItem('gateway-recent-cwds') || '[]');
      return raw.map((item) =>
        typeof item === 'string'
          ? { path: item, accessedAt: new Date().toISOString() }
          : item as RecentCwd,
      );
    } catch { return []; }
  })(),

  contextFiles: [],
  addContextFile: (file) =>
    set((s) => {
      if (s.contextFiles.some((f) => f.path === file.path)) return s;
      return { contextFiles: [...s.contextFiles, { ...file, id: crypto.randomUUID() }] };
    }),
  removeContextFile: (id) =>
    set((s) => ({ contextFiles: s.contextFiles.filter((f) => f.id !== id) })),
  clearContextFiles: () => set({ contextFiles: [] }),
}), { name: 'app-store' }));
