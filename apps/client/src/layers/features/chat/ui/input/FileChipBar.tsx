import { useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Loader2, File as FileIcon, AlertCircle } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { PendingFile } from '../../model/use-file-upload';

/** Check if a File is an image by MIME type. */
function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

/** Fallback reason for a failed upload that carried no message. */
const GENERIC_UPLOAD_ERROR = "This file didn't upload";

interface FileChipBarProps {
  files: PendingFile[];
  onRemove: (id: string) => void;
  /** Put a failed file back in line for the next send. Omit to hide the retry. */
  onRetry?: (id: string) => void;
}

/**
 * Horizontal bar of file chips showing pending uploads with status indicators.
 *
 * A failed upload states its reason on the chip and offers a retry. It used to
 * render a bare red icon with no words, so a person had no way to know the
 * attachment never arrived — and the send went out without it (DOR-480).
 */
export function FileChipBar({ files, onRemove, onRetry }: FileChipBarProps) {
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
          const failed = file.status === 'error';

          return (
            <motion.div
              key={file.id}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.15 }}
              className={cn(
                'flex items-center gap-1 rounded-md px-2 py-1 text-xs',
                failed ? 'bg-destructive/10 border-destructive/40 border' : 'bg-muted'
              )}
            >
              {file.status === 'uploading' ? (
                <Loader2 className="text-muted-foreground size-3 animate-spin" />
              ) : failed ? (
                <AlertCircle className="text-destructive size-3 shrink-0" />
              ) : thumbUrl ? (
                <img src={thumbUrl} alt="" className="size-5 shrink-0 rounded object-cover" />
              ) : (
                <FileIcon className="text-muted-foreground size-3" />
              )}

              <span className="max-w-32 truncate">{file.file.name}</span>

              {file.status === 'uploading' && (
                <span className="text-muted-foreground tabular-nums">{file.progress}%</span>
              )}

              {failed && (
                <>
                  <span
                    className="text-destructive max-w-44 truncate"
                    title={file.error ?? GENERIC_UPLOAD_ERROR}
                  >
                    {file.error ?? GENERIC_UPLOAD_ERROR}
                  </span>
                  {onRetry && (
                    <button
                      type="button"
                      onClick={() => onRetry(file.id)}
                      className="text-foreground ml-0.5 shrink-0 rounded-sm font-medium underline decoration-dotted underline-offset-2"
                      aria-label={`Try uploading ${file.file.name} again`}
                    >
                      Try again
                    </button>
                  )}
                </>
              )}

              <button
                type="button"
                onClick={() => onRemove(file.id)}
                className="text-muted-foreground hover:text-foreground -mr-0.5 ml-0.5 shrink-0 rounded-sm p-0.5"
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
