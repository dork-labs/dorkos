import { App, TFile } from 'obsidian';
import { PlatformAdapter } from '@dorkos/client/lib/platform';

export function createObsidianAdapter(app: App): PlatformAdapter {
  return {
    isEmbedded: true,
    openFile: async (path: string) => {
      const file = app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await app.workspace.getLeaf(false).openFile(file);
      }
    },
  };
}
