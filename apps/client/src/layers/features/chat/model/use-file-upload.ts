import { useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTransport, useAppStore } from '@/layers/shared/model';
import type { UploadResult, UploadProgress } from '@dorkos/shared/types';

/** A file pending upload with status and progress tracking. */
export interface PendingFile {
  /** Unique identifier for the pending file entry. */
  id: string;
  /** The browser File object selected by the user. */
  file: File;
  /** Current lifecycle state of this upload. */
  status: 'pending' | 'uploading' | 'uploaded' | 'error';
  /** Upload progress percentage (0–100). Batch-level, not per-file. */
  progress: number;
  /** Upload result from the server — available once status is 'uploaded'. */
  result?: UploadResult;
  /** Error message — available once status is 'error'. */
  error?: string;
}

/**
 * Manages pending file state, upload mutations, and saved-path extraction for chat.
 *
 * Files accumulate in `pendingFiles` until `uploadAndGetPaths()` is called on submit,
 * which uploads them all in one batch and returns their `savedPath` values for
 * injection into the outgoing message.
 *
 * @returns File upload state and action callbacks for use in ChatInputContainer / ChatPanel.
 */
export function useFileUpload() {
  const transport = useTransport();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);

  /** Append files to the pending list with status 'pending'. */
  const addFiles = useCallback((files: File[]) => {
    const newPending: PendingFile[] = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      status: 'pending',
      progress: 0,
    }));
    setPendingFiles((prev) => [...prev, ...newPending]);
  }, []);

  /** Remove a single pending file by its id. */
  const removeFile = useCallback((id: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  /** Clear all pending files. */
  const clearFiles = useCallback(() => {
    setPendingFiles([]);
  }, []);

  /**
   * Put a failed file back in line so the next send uploads it again.
   *
   * The whole retry: a `pending` file is what the send path picks up, so
   * resetting the status is the retry. No separate upload trigger, no state
   * machine.
   */
  const retryFile = useCallback((id: string) => {
    setPendingFiles((prev) =>
      prev.map((f) =>
        f.id === id && f.status === 'error'
          ? { ...f, status: 'pending' as const, progress: 0, error: undefined }
          : f
      )
    );
  }, []);

  const uploadMutation = useMutation({
    mutationFn: async (files: PendingFile[]) => {
      if (!selectedCwd) throw new Error('No working directory selected');

      // Mark all queued files as uploading
      setPendingFiles((prev) =>
        prev.map((f) =>
          files.some((tf) => tf.id === f.id) ? { ...f, status: 'uploading' as const } : f
        )
      );

      const onProgress = (progress: UploadProgress) => {
        setPendingFiles((prev) =>
          prev.map((f) => (f.status === 'uploading' ? { ...f, progress: progress.percentage } : f))
        );
      };

      const rawFiles = files.map((f) => f.file);
      return transport.uploadFiles(rawFiles, selectedCwd, onProgress);
    },
    onSuccess: (results, files) => {
      setPendingFiles((prev) =>
        prev.map((f) => {
          const idx = files.findIndex((tf) => tf.id === f.id);
          if (idx === -1) return f;
          return {
            ...f,
            status: 'uploaded' as const,
            progress: 100,
            result: results[idx],
          };
        })
      );
    },
    onError: (error: Error) => {
      setPendingFiles((prev) =>
        prev.map((f) =>
          f.status === 'uploading' ? { ...f, status: 'error' as const, error: error.message } : f
        )
      );
    },
  });

  /**
   * Upload every not-yet-uploaded file and return the saved paths of ALL
   * attachments — already-uploaded ones included — for message injection.
   *
   * THROWS when any attachment is in `error`. It used to filter those out
   * silently, so a message went to the model with no attachment (or a partial
   * one) while the person waited for an answer about a file the agent never
   * received (DOR-480). The composer refuses to send while a chip is in error
   * (`hasFailedUpload`), which is where a person can act on it; this throw is the
   * backstop for the queue flush, which has nobody to ask.
   */
  const uploadAndGetPaths = useCallback(async (): Promise<string[]> => {
    const failed = pendingFiles.filter((f) => f.status === 'error');
    if (failed.length > 0) {
      throw new Error(
        failed.length === 1
          ? `${failed[0].file.name} did not upload. Retry it or remove it, then send again.`
          : `${failed.length} attachments did not upload. Retry them or remove them, then send again.`
      );
    }

    const uploadedPaths = pendingFiles
      .filter((f) => f.status === 'uploaded' && f.result)
      .map((f) => f.result!.savedPath);

    const toUpload = pendingFiles.filter((f) => f.status === 'pending');
    if (toUpload.length === 0) return uploadedPaths;

    const results = await uploadMutation.mutateAsync(toUpload);
    return [...uploadedPaths, ...results.map((r) => r.savedPath)];
  }, [pendingFiles, uploadMutation]);

  return {
    pendingFiles,
    addFiles,
    removeFile,
    retryFile,
    clearFiles,
    uploadAndGetPaths,
    hasPendingFiles: pendingFiles.length > 0,
    /** True while any attachment failed to upload — the send must not go out. */
    hasFailedUpload: pendingFiles.some((f) => f.status === 'error'),
    isUploading: uploadMutation.isPending,
  };
}
