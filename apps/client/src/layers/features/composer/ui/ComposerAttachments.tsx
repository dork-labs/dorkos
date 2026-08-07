import { useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Loader2, File as FileIcon, AlertCircle } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { PendingFile } from '../model/pending-file';

/** Check if a File is an image by MIME type. */
function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

/** Fallback reason for a failed upload that carried no message. */
const GENERIC_UPLOAD_ERROR = "This file didn't upload";

interface ComposerAttachmentsProps {
  files: PendingFile[];
  onRemove: (id: string) => void;
  /** Put a failed file back in line for the next send. Omit to hide the retry. */
  onRetry?: (id: string) => void;
  /**
   * Stop the upload in flight. Takes no id because there is only ever one
   * request: every queued file goes up in a single batch, so any uploading
   * chip's control ends the same one. Omit where the host cannot cancel.
   */
  onCancel?: () => void;
}

/**
 * Horizontal bar of file chips showing pending uploads with status indicators.
 *
 * A failed upload states its reason on the chip and offers a retry. It used to
 * render a bare red icon with no words, so a person had no way to know the
 * attachment never arrived — and the send went out without it (DOR-480).
 *
 * While a chip is uploading its X cancels the request instead of removing the
 * row. Removing the row was the honest-looking option and the wrong one: the
 * chip vanished while the bytes kept flowing (DOR-494).
 */
export function ComposerAttachments({
  files,
  onRemove,
  onRetry,
  onCancel,
}: ComposerAttachmentsProps) {
  // Which images are on the bar, as a value that changes only when they do. The
  // array's identity cannot serve: every upload progress tick rebuilds it
  // (`prev.map(...)` in use-file-upload), so a memo keyed on it minted a fresh
  // URL for the same bytes and revoked the one the <img> was still pointing at,
  // many times a second, per image.
  //
  // Ids are enough because a `PendingFile` never swaps the `File` it was created
  // with — a retry rewrites `status` and clears `error`, and progress rewrites
  // `progress`; both carry `f.file` through untouched.
  const imageIds = files
    .filter((f) => isImageFile(f.file))
    .map((f) => f.id)
    .join(' ');

  const thumbnailUrls = useMemo(() => {
    const urls = new Map<string, string>();
    for (const f of files) {
      if (isImageFile(f.file)) urls.set(f.id, URL.createObjectURL(f.file));
    }
    return urls;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `imageIds` IS the identity of the images in `files`; depending on the array itself is the bug above
  }, [imageIds]);

  // Revoke a generation of URLs once the set of images has moved on, or the bar
  // has gone away.
  useEffect(() => {
    return () => {
      for (const url of thumbnailUrls.values()) URL.revokeObjectURL(url);
    };
  }, [thumbnailUrls]);

  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-1.5">
      <AnimatePresence>
        {files.map((file) => {
          const thumbUrl = thumbnailUrls.get(file.id);
          const failed = file.status === 'error';
          const cancelable = file.status === 'uploading' && onCancel !== undefined;

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
                onClick={cancelable ? onCancel : () => onRemove(file.id)}
                className="text-muted-foreground hover:text-foreground -mr-0.5 ml-0.5 shrink-0 rounded-sm p-0.5"
                aria-label={
                  cancelable ? `Cancel upload of ${file.file.name}` : `Remove ${file.file.name}`
                }
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
