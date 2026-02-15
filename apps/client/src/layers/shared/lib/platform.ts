export interface PlatformAdapter {
  /** Whether running inside Obsidian */
  isEmbedded: boolean;
  /** Get current session ID */
  getSessionId: () => string | null;
  /** Set current session ID */
  setSessionId: (id: string | null) => void;
  /** Open a file by path (no-op in standalone) */
  openFile: (path: string) => Promise<void>;
}

// Default: standalone web adapter
const webAdapter: PlatformAdapter = {
  isEmbedded: false,
  getSessionId: () => new URLSearchParams(location.search).get('session'),
  setSessionId: (id) => {
    const url = new URL(location.href);
    if (id) url.searchParams.set('session', id);
    else url.searchParams.delete('session');
    history.replaceState(null, '', url);
  },
  openFile: async () => {},
};

let currentAdapter: PlatformAdapter = webAdapter;

export function setPlatformAdapter(adapter: PlatformAdapter) {
  currentAdapter = adapter;
}

export function getPlatform(): PlatformAdapter {
  return currentAdapter;
}
