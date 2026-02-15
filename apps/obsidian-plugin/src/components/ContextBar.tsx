import { useState } from 'react';
import { X, FileText } from 'lucide-react';
import { TFile } from 'obsidian';
import { useObsidian } from '../contexts/ObsidianContext';
import type { ActiveFileInfo } from '../hooks/use-active-file';
import type { ContextFile } from '@dorkos/client/stores/app-store';

interface ContextBarProps {
  activeFile: ActiveFileInfo | null;
  contextFiles: ContextFile[];
  onRemoveFile: (id: string) => void;
  onDrop: (path: string, basename: string) => void;
  onFileClick: (path: string) => void;
}

export function ContextBar({
  activeFile,
  contextFiles,
  onRemoveFile,
  onDrop,
  onFileClick,
}: ContextBarProps) {
  const { app } = useObsidian();
  const [isDragOver, setIsDragOver] = useState(false);
  const hasContext = activeFile || contextFiles.length > 0;

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };
  const handleDragLeave = () => {
    setIsDragOver(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const path = e.dataTransfer.getData('text/plain');
    if (!path) return;
    const file = app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      onDrop(file.path, file.basename);
    }
  };

  return (
    <div
      role="region"
      className={`min-w-0 flex-1 transition-colors ${isDragOver ? 'bg-accent/50' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex flex-wrap gap-1.5">
        {activeFile && (
          <button
            onClick={() => onFileClick(activeFile.path)}
            className="bg-primary/10 text-primary border-primary/20 hover:bg-primary/20 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition-colors"
          >
            <FileText className="h-3 w-3" />
            <span className="max-w-[120px] truncate">{activeFile.basename}</span>
            <span className="text-[10px] opacity-60">(active)</span>
          </button>
        )}
        {contextFiles.map((file) => (
          <span
            key={file.id}
            className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs"
          >
            <button
              onClick={() => onFileClick(file.path)}
              className="hover:text-foreground inline-flex items-center gap-1 transition-colors"
            >
              <FileText className="h-3 w-3" />
              <span className="max-w-[120px] truncate">{file.basename}</span>
            </button>
            <button
              onClick={() => onRemoveFile(file.id)}
              className="hover:text-destructive ml-0.5 transition-colors"
              aria-label={`Remove ${file.basename}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      {!hasContext && (
        <p className="text-muted-foreground py-1 text-center text-[10px]">
          Drop files here for context
        </p>
      )}
    </div>
  );
}
