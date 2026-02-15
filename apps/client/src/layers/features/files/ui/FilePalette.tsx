import { useEffect } from 'react';
import { motion } from 'motion/react';
import { File, Folder } from 'lucide-react';

export interface FileEntry {
  path: string;
  filename: string;
  directory: string;
  isDirectory: boolean;
}

interface FilePaletteProps {
  filteredFiles: Array<FileEntry & { indices: number[] }>;
  selectedIndex: number;
  onSelect: (entry: FileEntry) => void;
}

function HighlightedText({
  text,
  indices,
  startOffset = 0,
}: {
  text: string;
  indices: number[];
  startOffset?: number;
}) {
  const highlightSet = new Set(indices.map((i) => i - startOffset));
  return (
    <>
      {text.split('').map((char, i) =>
        highlightSet.has(i) ? (
          <span key={i} className="font-semibold text-foreground">{char}</span>
        ) : (
          <span key={i}>{char}</span>
        ),
      )}
    </>
  );
}

export function FilePalette({ filteredFiles, selectedIndex, onSelect }: FilePaletteProps) {
  useEffect(() => {
    const activeEl = document.getElementById(`file-item-${selectedIndex}`);
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: 4 }}
      transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
      className="absolute bottom-full left-0 right-0 mb-2 max-h-80 overflow-hidden rounded-lg border bg-popover shadow-lg"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div id="file-palette-listbox" role="listbox" className="max-h-72 overflow-y-auto p-2">
        {filteredFiles.length === 0 ? (
          <div className="px-2 py-4 text-center text-sm text-muted-foreground">No files found.</div>
        ) : (
          filteredFiles.map((entry, index) => {
            const isSelected = index === selectedIndex;
            const Icon = entry.isDirectory ? Folder : File;
            return (
              <div
                key={entry.path}
                id={`file-item-${index}`}
                role="option"
                aria-selected={isSelected}
                data-selected={isSelected}
                onClick={() => onSelect(entry)}
                className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors duration-100 data-[selected=true]:bg-ring/10 data-[selected=true]:text-foreground hover:bg-muted"
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-sm truncate">
                  <HighlightedText text={entry.filename} indices={entry.indices} startOffset={entry.directory.length} />
                </span>
                {entry.directory && (
                  <span className="text-xs text-muted-foreground truncate">{entry.directory}</span>
                )}
              </div>
            );
          })
        )}
      </div>
    </motion.div>
  );
}
