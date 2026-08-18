/**
 * The chip bar behind a room's composer — chat's file upload, pointed at a room.
 *
 * The same hook as `features/chat/model/use-file-upload`, with the two
 * differences a room forces: it uploads to the ROOM rather than to a working
 * directory (a room has none, and reaching for one is the bug this whole
 * feature exists to avoid), and it hands back attachment IDS rather than saved
 * paths, because a room's post names its files by id.
 *
 * It lives in the widget rather than the room entity because it needs
 * `PendingFile`, which the composer feature owns: a widget may import a feature
 * and an entity may not (`.claude/rules/fsd-layers.md`).
 *
 * @module widgets/room-view/model/use-room-attachments
 */
import { useCallback, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { RoomAttachment } from '@dorkos/shared/room-schemas';
import type { UploadProgress } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';
import type { PendingFile } from '@/layers/features/composer';

/**
 * Hold files for a room's composer until the message that carries them is sent.
 *
 * **Two composers never share a bar, and that is structural rather than keyed.**
 * A room's composer and an open thread's composer are two mounts, so each gets
 * its own `pendingFiles` from its own `useState` — there is no store to collide
 * in and no key to get wrong. `roomId` is therefore only where the bytes GO; a
 * thread's files upload to the room the thread is in, which is also the room
 * that will serve them back.
 *
 * @param roomId - The room the files are uploaded into.
 * @returns The chip bar's state and the actions `ChannelComposer` wires to it.
 */
export function useRoomAttachments(roomId: string) {
  const transport = useTransport();
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);

  /**
   * Which attachment id each uploaded chip earned.
   *
   * A ref rather than a field on `PendingFile`: that shape is the composer
   * feature's and its `result` slot is typed `UploadResult`, which is chat's
   * answer and has no id on it. Widening it would put a room's wire type into
   * every surface's chip, so the mapping stays here, where it is read exactly
   * once — by `uploadAndGetIds`, in a callback, where a ref is never stale.
   */
  const attachmentIdsByFile = useRef(new Map<string, string>());

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
    attachmentIdsByFile.current.delete(id);
    setPendingFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  /**
   * Drop the files a send has finished with.
   *
   * **Takes the batch it is clearing, and that is the whole point.** A send
   * awaits its upload before clearing, and a person can drop another file into
   * the bar during that await — so clearing "everything" clears something that
   * was never sent, never uploaded, and never reported. Naming the batch keeps
   * the removal to exactly what went out.
   *
   * @param fileIds - The pending-file ids the send consumed. Omit to clear the
   *   bar entirely, which is what leaving a room should do.
   */
  const clearFiles = useCallback((fileIds?: readonly string[]) => {
    if (!fileIds) {
      attachmentIdsByFile.current.clear();
      setPendingFiles([]);
      return;
    }
    const sent = new Set(fileIds);
    for (const id of sent) attachmentIdsByFile.current.delete(id);
    setPendingFiles((prev) => prev.filter((f) => !sent.has(f.id)));
  }, []);

  /**
   * Put a failed file back in line so the next send uploads it again.
   *
   * The whole retry: a `pending` file is what the send path picks up, so
   * resetting the status is the retry. No separate upload trigger, no state
   * machine.
   */
  const retryFile = useCallback((id: string) => {
    attachmentIdsByFile.current.delete(id);
    setPendingFiles((prev) =>
      prev.map((f) =>
        f.id === id && f.status === 'error'
          ? { ...f, status: 'pending' as const, progress: 0, error: undefined }
          : f
      )
    );
  }, []);

  // The live request's abort handle. A ref rather than state because nothing
  // renders from it: `isUploading` already says whether a cancel is on offer,
  // and the handle only has to be reachable from the click.
  const abortRef = useRef<AbortController | null>(null);

  const uploadMutation = useMutation({
    // The chip already names the file and says what happened to it, and the
    // composer refuses to send while one is in error. An app-wide toast would be
    // a third, vaguer voice — and after someone presses Cancel it is simply
    // wrong: "Action failed. Please try again." about the thing they chose to
    // stop.
    meta: { suppressErrorToast: true },
    mutationFn: async (files: PendingFile[]) => {
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

      const controller = new AbortController();
      abortRef.current = controller;

      const rawFiles = files.map((f) => f.file);
      return transport.uploadRoomAttachments(roomId, rawFiles, onProgress, controller.signal);
    },
    onSettled: () => {
      abortRef.current = null;
    },
    onSuccess: (attachments: RoomAttachment[], files: PendingFile[]) => {
      // The route answers in request order, which is the order the files went
      // up in — so index is the join, exactly as chat's is.
      files.forEach((f, i) => {
        const attachment = attachments[i];
        if (attachment) attachmentIdsByFile.current.set(f.id, attachment.id);
      });
      setPendingFiles((prev) =>
        prev.map((f) => {
          const idx = files.findIndex((tf) => tf.id === f.id);
          if (idx === -1) return f;
          return { ...f, status: 'uploaded' as const, progress: 100 };
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
   * Stop the upload that is running right now.
   *
   * Aborts the REQUEST, not just this hook's view of it. Without that the bytes
   * keep flowing while the composer pretends to be free, and a stalled request
   * holds `isUploading` true forever — a disabled spinner where the send button
   * belongs, and an Enter key that does nothing (DOR-494).
   *
   * The upload is one batch in one request, so this ends all of it. The
   * rejection travels the same path every other upload failure does: each chip
   * says it was canceled and offers a retry or a remove.
   */
  const cancelUpload = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * Upload every not-yet-uploaded file and return the ids of ALL of them —
   * already-uploaded ones included — in the order they will render.
   *
   * THROWS when any attachment is in `error`. Filtering those out silently is
   * how a message went to the model with no attachment while the person waited
   * for an answer about a file it never received (DOR-480). The composer refuses
   * to send while a chip is in error (`hasFailedUpload`), which is where a
   * person can act on it; this throw is the backstop for any path that has
   * nobody to ask.
   */
  const uploadAndGetIds = useCallback(async (): Promise<string[]> => {
    const failed = pendingFiles.filter((f) => f.status === 'error');
    if (failed.length > 0) {
      throw new Error(
        failed.length === 1
          ? `${failed[0].file.name} did not upload. Retry it or remove it, then send again.`
          : `${failed.length} attachments did not upload. Retry them or remove them, then send again.`
      );
    }

    const toUpload = pendingFiles.filter((f) => f.status === 'pending');
    if (toUpload.length > 0) await uploadMutation.mutateAsync(toUpload);

    // Read back in `pendingFiles` order, not in upload order: the ids the post
    // names ARE the render order, and an already-uploaded file that was added
    // first must stay first even though it did not go up in this batch.
    return pendingFiles
      .map((f) => attachmentIdsByFile.current.get(f.id))
      .filter((id): id is string => id !== undefined);
  }, [pendingFiles, uploadMutation]);

  return {
    pendingFiles,
    addFiles,
    removeFile,
    retryFile,
    clearFiles,
    cancelUpload,
    uploadAndGetIds,
    hasPendingFiles: pendingFiles.length > 0,
    /** True while any attachment failed to upload — the send must not go out. */
    hasFailedUpload: pendingFiles.some((f) => f.status === 'error'),
    isUploading: uploadMutation.isPending,
  };
}
