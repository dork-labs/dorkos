import { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';

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
