import { useState } from 'react';
import { X, FileText } from 'lucide-react';
import { TFile } from 'obsidian';
import { useObsidian } from '../contexts/ObsidianContext';
import type { ActiveFileInfo } from '../hooks/use-active-file';
import type { ContextFile } from '@lifeos/client/stores/app-store';

interface ContextBarProps {
  activeFile: ActiveFileInfo | null;
  contextFiles: ContextFile[];
  onRemoveFile: (id: string) => void;
  onDrop: (path: string, basename: string) => void;
  onFileClick: (path: string) => void;
}

export function ContextBar({ activeFile, contextFiles, onRemoveFile, onDrop, onFileClick }: ContextBarProps) {
  const { app } = useObsidian();
  const [isDragOver, setIsDragOver] = useState(false);
  const hasContext = activeFile || contextFiles.length > 0;

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true); };
  const handleDragLeave = () => { setIsDragOver(false); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const path = e.dataTransfer.getData('text/plain');
    if (!path) return;
    const file = app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) { onDrop(file.path, file.basename); }
  };

  return (
    <div
      className={`flex-1 min-w-0 transition-colors ${isDragOver ? 'bg-accent/50' : ''}`}
      onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
    >
      <div className="flex flex-wrap gap-1.5">
        {activeFile && (
          <button onClick={() => onFileClick(activeFile.path)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors">
            <FileText className="h-3 w-3" />
            <span className="max-w-[120px] truncate">{activeFile.basename}</span>
            <span className="text-[10px] opacity-60">(active)</span>
          </button>
        )}
        {contextFiles.map((file) => (
          <span key={file.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-muted text-muted-foreground border">
            <button onClick={() => onFileClick(file.path)} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
              <FileText className="h-3 w-3" />
              <span className="max-w-[120px] truncate">{file.basename}</span>
            </button>
            <button onClick={() => onRemoveFile(file.id)} className="ml-0.5 hover:text-destructive transition-colors" aria-label={`Remove ${file.basename}`}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      {!hasContext && (
        <p className="text-[10px] text-muted-foreground text-center py-1">Drop files here for context</p>
      )}
    </div>
  );
}
