import { useCallback } from 'react';
import { TFile } from 'obsidian';
import { App } from '@dorkos/client/App';
import { useAppStore } from '@dorkos/client/stores/app-store';
import { useObsidian } from '../contexts/ObsidianContext';
import { useActiveFile } from '../hooks/use-active-file';
import { useFileOpener } from '../hooks/use-file-opener';
import { ContextBar } from './ContextBar';

/** Root component for the DorkOS Obsidian plugin view. */
export function ObsidianApp() {
  const { app } = useObsidian();
  const activeFile = useActiveFile();
  const { contextFiles, addContextFile, removeContextFile } = useAppStore();
  const { openFile } = useFileOpener();

  const transformContent = useCallback(
    async (content: string): Promise<string> => {
      const parts: string[] = [];

      if (activeFile) {
        const file = app.vault.getAbstractFileByPath(activeFile.path);
        if (file instanceof TFile) {
          const text = await app.vault.cachedRead(file);
          parts.push(`<context file="${activeFile.path}">\n${text}\n</context>`);
        }
      }

      for (const cf of contextFiles) {
        if (activeFile && cf.path === activeFile.path) continue;
        const file = app.vault.getAbstractFileByPath(cf.path);
        if (file instanceof TFile) {
          const text = await app.vault.cachedRead(file);
          parts.push(`<context file="${cf.path}">\n${text}\n</context>`);
        }
      }

      if (parts.length > 0) {
        return parts.join('\n\n') + '\n\n' + content;
      }
      return content;
    },
    [app, activeFile, contextFiles]
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center border-b px-3 py-1.5">
        <ContextBar
          activeFile={activeFile}
          contextFiles={contextFiles}
          onRemoveFile={removeContextFile}
          onDrop={(path, basename) => addContextFile({ path, basename })}
          onFileClick={openFile}
        />
      </div>
      <App transformContent={transformContent} embedded />
    </div>
  );
}
