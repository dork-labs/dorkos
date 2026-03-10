import { motion, AnimatePresence } from 'motion/react';
import { X, Loader2, File as FileIcon, AlertCircle } from 'lucide-react';
import type { PendingFile } from '../model/use-file-upload';

interface FileChipBarProps {
  files: PendingFile[];
  onRemove: (id: string) => void;
}

/** Horizontal bar of file chips showing pending uploads with status indicators. */
export function FileChipBar({ files, onRemove }: FileChipBarProps) {
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-1.5">
      <AnimatePresence>
        {files.map((file) => (
          <motion.div
            key={file.id}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.15 }}
            className="bg-muted flex items-center gap-1 rounded-md px-2 py-1 text-xs"
          >
            {file.status === 'uploading' ? (
              <Loader2 className="text-muted-foreground size-3 animate-spin" />
            ) : file.status === 'error' ? (
              <AlertCircle className="size-3 text-destructive" />
            ) : (
              <FileIcon className="text-muted-foreground size-3" />
            )}

            <span className="max-w-32 truncate">{file.file.name}</span>

            {file.status === 'uploading' && (
              <span className="text-muted-foreground tabular-nums">{file.progress}%</span>
            )}

            <button
              type="button"
              onClick={() => onRemove(file.id)}
              className="text-muted-foreground hover:text-foreground -mr-0.5 ml-0.5 rounded-sm p-0.5"
              aria-label={`Remove ${file.file.name}`}
            >
              <X className="size-3" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
