import { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { hasFilePathDrag, readFilePathDrag } from '@/layers/shared/lib';

interface UseDragAndPasteOptions {
  onFilesSelected: (files: File[]) => void;
}

/** Dropzone + clipboard-paste file handling for the chat input container. */
export function useDragAndPaste({ onFilesSelected }: UseDragAndPasteOptions) {
  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) onFilesSelected(acceptedFiles);
    },
    [onFilesSelected]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true,
  });

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      const files = Array.from(e.clipboardData.items)
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length > 0) onFilesSelected(files);
    },
    [onFilesSelected]
  );

  return { getRootProps, getInputProps, isDragActive, handlePaste };
}

/**
 * Handlers for a file dragged out of the file tree, or `null` when the surface
 * accepts none.
 *
 * Separate from the dropzone above because it is a different kind of drop: the
 * tree drags a REFERENCE to a file the machine already has, not the file's
 * bytes, so it becomes text in the box rather than an upload.
 */
export interface PathDropHandlers {
  onDragOver: (e: React.DragEvent) => void;
  /** Handle a drop; `true` when it carried a path and this consumed it. */
  onDrop: (e: React.DragEvent) => boolean;
}

/**
 * Accept a file dragged from the file tree.
 *
 * @param onPathDropped - Called with the dropped file's working-directory-relative
 *   path. Omitted => this surface takes no path drops, and the hook returns `null`.
 */
export function usePathDrop(
  onPathDropped: ((path: string) => void) | undefined
): PathDropHandlers | null {
  const onDragOver = useCallback((e: React.DragEvent) => {
    // Only claiming the drag once it is ours; an operating-system file drop
    // must fall through to the dropzone untouched.
    if (!hasFilePathDrag(e.dataTransfer.types)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent): boolean => {
      if (!onPathDropped) return false;
      const path = readFilePathDrag(e.dataTransfer);
      if (path === null) return false;
      e.preventDefault();
      onPathDropped(path);
      return true;
    },
    [onPathDropped]
  );

  return onPathDropped ? { onDragOver, onDrop } : null;
}
