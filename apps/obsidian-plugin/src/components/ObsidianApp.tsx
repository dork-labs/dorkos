import { useCallback, useEffect, useRef } from 'react';
import { TFile } from 'obsidian';
import { App } from '@lifeos/client/App';
import { useAppStore } from '@lifeos/client/stores/app-store';
import { useTransport } from '@lifeos/client/contexts/TransportContext';
import { useObsidian } from '../contexts/ObsidianContext';
import { useActiveFile } from '../hooks/use-active-file';
import { useFileOpener } from '../hooks/use-file-opener';
import { ContextBar } from './ContextBar';

export function ObsidianApp() {
  const { app } = useObsidian();
  const transport = useTransport();
  const activeFile = useActiveFile();
  const { contextFiles, addContextFile, removeContextFile, setSessionId } = useAppStore();
  const { openFile } = useFileOpener();
  const autoCreatedRef = useRef(false);

  // Auto-create session on mount
  useEffect(() => {
    if (autoCreatedRef.current) return;
    autoCreatedRef.current = true;
    transport.createSession({ permissionMode: 'default' }).then((session) => {
      setSessionId(session.id);
    });
  }, [transport, setSessionId]);

  const transformContent = useCallback(async (content: string): Promise<string> => {
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
  }, [app, activeFile, contextFiles]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-3 py-1.5 border-b">
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
