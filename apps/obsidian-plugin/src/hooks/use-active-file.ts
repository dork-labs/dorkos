import { useState, useEffect } from 'react';
import { TFile } from 'obsidian';
import { useObsidian } from '../contexts/ObsidianContext';

export interface ActiveFileInfo {
  path: string;
  basename: string;
  extension: string;
}

export function useActiveFile(): ActiveFileInfo | null {
  const { app } = useObsidian();
  const [activeFile, setActiveFile] = useState<ActiveFileInfo | null>(() => {
    const file = app.workspace.getActiveFile();
    return file ? { path: file.path, basename: file.basename, extension: file.extension } : null;
  });

  useEffect(() => {
    const handler = () => {
      const file = app.workspace.getActiveFile();
      setActiveFile(file ? { path: file.path, basename: file.basename, extension: file.extension } : null);
    };
    const ref = app.workspace.on('active-leaf-change', handler);
    return () => { app.workspace.offref(ref); };
  }, [app]);

  return activeFile;
}
