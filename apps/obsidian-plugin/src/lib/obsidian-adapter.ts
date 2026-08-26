import { App, TFile } from 'obsidian';
import { PlatformAdapter } from '@dorkos/client/lib/platform';

/**
 * Create a PlatformAdapter backed by the Obsidian vault and workspace APIs.
 *
 * @param app - The Obsidian app this panel is running in.
 * @param capabilities - What this particular window can do, settled by the view
 *   before bootstrap. `canSearchMessages` is whether `openEmbeddedIndex` found a
 *   message index on this machine — the embed is no longer categorically without
 *   one (DOR-1563), so the answer is per-window rather than per-shell.
 */
export function createObsidianAdapter(
  app: App,
  capabilities: { canSearchMessages: boolean }
): PlatformAdapter {
  return {
    isEmbedded: true,
    canSearchMessages: capabilities.canSearchMessages,
    openFile: async (path: string) => {
      const file = app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await app.workspace.getLeaf(false).openFile(file);
      }
    },
  };
}
