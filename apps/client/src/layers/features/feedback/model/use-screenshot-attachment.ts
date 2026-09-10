/**
 * The one screenshot a feedback submission may carry, and the three ways a
 * person can hand one over (feedback-attachments PR 2).
 *
 * Paste, drag-and-drop and the file picker all land here, go through the same
 * compression step, and end up as the same bounded `data:` URL. One image at a
 * time on purpose: a second attach replaces the first rather than growing a
 * list, because the submission carries a single `screenshot` field and a queue
 * the wire cannot express would only be a way to lose pictures quietly.
 *
 * Nothing is ever attached on its own — every path through this hook starts
 * with a deliberate act (feedback-attachments decision 12), and every refusal
 * is toasted rather than swallowed.
 *
 * @module features/feedback/model/use-screenshot-attachment
 */
import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { toast } from 'sonner';
import { compressImage, ImageCompressError, type ImageCompressReason } from '@/layers/shared/lib';

/**
 * What the user is told when an image is refused.
 *
 * Plain, specific, and actionable — a person who pasted a 12-megapixel photo
 * needs to know it was too big, not that "an error occurred".
 */
const REFUSAL_MESSAGE: Record<ImageCompressReason, string> = {
  'too-large': 'That image is too big to send, even after shrinking it. Try a smaller one.',
  unreadable: 'Couldn’t read that image. Try a PNG or JPEG.',
  unsupported: 'This browser can’t prepare images to send.',
};

/** Shown when something that is not a picture is dropped or pasted in. */
const NOT_AN_IMAGE_MESSAGE = 'Only images can be attached.';

/** The `dataTransfer` type name browsers use for a drag carrying real files. */
const FILES_DRAG_TYPE = 'Files';

/** Whether a drag carries files from outside the app (rather than an in-app reference). */
function dragCarriesFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types).includes(FILES_DRAG_TYPE);
}

/** The first picture among a set of dropped or pasted files, if there is one. */
function firstImage(files: readonly File[]): File | undefined {
  return files.find((file) => file.type.startsWith('image/'));
}

/** Options for {@link useScreenshotAttachment}. */
export interface ScreenshotAttachmentOptions {
  /**
   * Called when a file drag first enters the surface, so the host can reveal
   * the drop target. Without it, dragging a picture onto a dialog whose
   * attachments panel is collapsed gives the user nowhere visible to aim.
   */
  onFileDragIn?: () => void;
  /**
   * Called once an image is attached, so the host can reveal it.
   *
   * Paste is the path that needs this: ⌘V works anywhere on the dialog, so
   * without it an image can land in a collapsed panel and the person who
   * pasted it sees nothing happen at all.
   */
  onAttached?: () => void;
}

/** What {@link useScreenshotAttachment} hands back to the dialog. */
export interface UseScreenshotAttachment {
  /** The compressed image that will be sent, or `null` when none is attached. */
  dataUrl: string | null;
  /** True while an image is being downscaled and encoded. */
  isPreparing: boolean;
  /** True while a file drag is over the surface, for the drag-over treatment. */
  isDraggingOver: boolean;
  /** Attach a picked, pasted, or dropped file, replacing any current one. */
  attach: (file: File) => Promise<void>;
  /** Drop the attached image. */
  clear: () => void;
  /**
   * Return to a known starting state without a toast — for a dialog reopening.
   *
   * @param initial - A `data:` URL to start attached (already compressed), or
   *   nothing to start empty.
   */
  reset: (initial?: string) => void;
  /** Handlers the host spreads onto the surface that accepts pastes and drops. */
  handlers: {
    onPaste: (event: ClipboardEvent) => void;
    onDragEnter: (event: DragEvent) => void;
    onDragOver: (event: DragEvent) => void;
    onDragLeave: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
  };
}

/**
 * Hold the submission's single optional screenshot.
 *
 * @param options - Optional host hooks; see {@link ScreenshotAttachmentOptions}.
 * @returns The attached image, the in-flight flag, and the paste/drag handlers.
 */
export function useScreenshotAttachment(
  options: ScreenshotAttachmentOptions = {}
): UseScreenshotAttachment {
  const { onFileDragIn, onAttached } = options;
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  // `dragenter`/`dragleave` also fire crossing every child boundary, so the
  // depth — not the last event — is what says whether the pointer is still
  // inside. A plain boolean flickers off the moment the drag crosses a label.
  const dragDepth = useRef(0);

  const attach = useCallback(
    async (file: File): Promise<void> => {
      if (!file.type.startsWith('image/')) {
        toast.error(NOT_AN_IMAGE_MESSAGE);
        return;
      }
      setIsPreparing(true);
      try {
        const compressed = await compressImage(file);
        setDataUrl(compressed);
        onAttached?.();
      } catch (error) {
        const reason: ImageCompressReason =
          error instanceof ImageCompressError ? error.reason : 'unreadable';
        toast.error(REFUSAL_MESSAGE[reason]);
      } finally {
        setIsPreparing(false);
      }
    },
    [onAttached]
  );

  const clear = useCallback(() => setDataUrl(null), []);

  const reset = useCallback((initial?: string) => {
    dragDepth.current = 0;
    setDataUrl(initial ?? null);
    setIsPreparing(false);
    setIsDraggingOver(false);
  }, []);

  const onPaste = useCallback(
    (event: ClipboardEvent) => {
      // `getAsFile` is the whole test: it answers `null` for every clipboard
      // item that is not a file, which is also what a `kind === 'file'` check
      // would filter on — one check, and the one that cannot be wrong.
      const files = Array.from(event.clipboardData?.items ?? [])
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      // Say nothing about a paste that carried no file at all — that is just
      // someone pasting text into the message box.
      if (files.length === 0) return;
      const image = firstImage(files);
      if (!image) {
        toast.error(NOT_AN_IMAGE_MESSAGE);
        return;
      }
      event.preventDefault();
      void attach(image);
    },
    [attach]
  );

  const onDragEnter = useCallback(
    (event: DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth.current += 1;
      if (dragDepth.current === 1) onFileDragIn?.();
      setIsDraggingOver(true);
    },
    [onFileDragIn]
  );

  const onDragOver = useCallback((event: DragEvent) => {
    // Claim the drag only when it is ours; anything else must keep falling
    // through to whatever else on the page wanted it.
    if (!dragCarriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragLeave = useCallback((event: DragEvent) => {
    if (!dragCarriesFiles(event.dataTransfer)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDraggingOver(false);
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setIsDraggingOver(false);
      const image = firstImage(Array.from(event.dataTransfer.files));
      if (!image) {
        toast.error(NOT_AN_IMAGE_MESSAGE);
        return;
      }
      void attach(image);
    },
    [attach]
  );

  return {
    dataUrl,
    isPreparing,
    isDraggingOver,
    attach,
    clear,
    reset,
    handlers: { onPaste, onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
