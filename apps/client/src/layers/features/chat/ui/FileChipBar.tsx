import { useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Loader2, File as FileIcon, AlertCircle } from 'lucide-react';
import type { PendingFile } from '../model/use-file-upload';

/** Check if a File is an image by MIME type. */
function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

interface FileChipBarProps {
  files: PendingFile[];
  onRemove: (id: string) => void;
}

/** Horizontal bar of file chips showing pending uploads with status indicators. */
export function FileChipBar({ files, onRemove }: FileChipBarProps) {
  // Create object URLs for image thumbnails, keyed by PendingFile id
  const thumbnailUrls = useMemo(() => {
    const urls = new Map<string, string>();
    for (const f of files) {
      if (isImageFile(f.file)) {
        urls.set(f.id, URL.createObjectURL(f.file));
      }
    }
    return urls;
  }, [files]);

  // Revoke object URLs when they're no longer needed
  useEffect(() => {
    return () => {
      for (const url of thumbnailUrls.values()) {
        URL.revokeObjectURL(url);
      }
    };
  }, [thumbnailUrls]);

  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-1.5">
      <AnimatePresence>
        {files.map((file) => {
          const thumbUrl = thumbnailUrls.get(file.id);

          return (
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
                <AlertCircle className="text-destructive size-3" />
              ) : thumbUrl ? (
                <img src={thumbUrl} alt="" className="size-5 shrink-0 rounded object-cover" />
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
          );
        })}
      </AnimatePresence>
    </div>
  );
}
