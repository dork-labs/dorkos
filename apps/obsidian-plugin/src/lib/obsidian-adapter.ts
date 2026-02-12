import { App, TFile } from 'obsidian';
import { PlatformAdapter } from '@lifeos/client/lib/platform';
import { useAppStore } from '@lifeos/client/stores/app-store';

export function createObsidianAdapter(app: App): PlatformAdapter {
  return {
    isEmbedded: true,
    getSessionId: () => useAppStore.getState().sessionId,
    setSessionId: (id) => useAppStore.getState().setSessionId(id),
    openFile: async (path: string) => {
      const file = app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await app.workspace.getLeaf(false).openFile(file);
      }
    },
  };
}
