/**
 * The one screenshot a feedback submission may carry, and the five ways a
 * person can hand one over (feedback-attachments PR 2, PR 3 and PR 4).
 *
 * Paste, drag-and-drop, the file picker, one-click "Capture app view" and
 * pointing at a single element all land here, go through the same compression
 * step, and end up as the same bounded `data:` URL. One image at a time on
 * purpose: a second attach replaces
 * the first rather than growing a list, because the submission carries a single
 * `screenshot` field and a queue the wire cannot express would only be a way to
 * lose pictures quietly.
 *
 * Nothing is ever attached on its own — every path through this hook starts
 * with a deliberate act (feedback-attachments decision 12), and every refusal
 * is toasted rather than swallowed.
 *
 * @module features/feedback/model/use-screenshot-attachment
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from 'react';
import { toast } from 'sonner';
import {
  AppCaptureError,
  captureAppShot,
  captureAppView,
  compressImage,
  ImageCompressError,
  isAcceptableImageDataUrl,
  type AppCaptureReason,
  type ImageCompressReason,
} from '@/layers/shared/lib';
import { cropShotToElement } from '../lib/element-crop';

/**
 * What the user is told when an image is refused.
 *
 * Plain, specific, and actionable — a person who pasted a 12-megapixel photo
 * needs to know it was too big, not that "an error occurred".
 */
const REFUSAL_MESSAGE: Record<ImageCompressReason, string> = {
  // Not "try a smaller file": every image is re-encoded at the same size here,
  // so a smaller FILE of the same picture changes nothing. Fewer pixels does.
  'too-large': 'That image is too big to send. Try cropping it to just the part that matters.',
  unreadable: 'Couldn’t read that image. Try a PNG or JPEG.',
  unsupported: 'This browser can’t prepare images to send.',
};

/**
 * What the user is told when the one-click capture came back with no picture.
 *
 * Both point at the other way in, because there is one and it is two clicks
 * away: a refusal that only says "no" leaves someone with a bug to report and
 * nowhere to go.
 */
const CAPTURE_REFUSAL_MESSAGE: Record<AppCaptureReason, string> = {
  failed: 'Couldn’t capture the app view. You can still add a screenshot yourself.',
  unsupported:
    'Couldn’t load what it takes to capture the app view. Reload the page, or add a screenshot yourself.',
};

/**
 * Which sentence a failed attach or capture earns.
 *
 * A capture goes through the same compressor as a picked file, so it can be
 * refused for either module's reasons — and "that image is too big" is the
 * honest answer for a capture too.
 */
function refusalMessage(error: unknown): string {
  if (error instanceof AppCaptureError) return CAPTURE_REFUSAL_MESSAGE[error.reason];
  if (error instanceof ImageCompressError) return REFUSAL_MESSAGE[error.reason];
  return REFUSAL_MESSAGE.unreadable;
}

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
   * Whether the surface is currently accepting images — the dialog being open,
   * on a transport that can actually send one.
   *
   * Drives the window-level guard against a drop that MISSES the dialog. A
   * browser's default action for a file dropped on a page is to navigate to it,
   * which replaces the app with a `file:///` view and takes the half-written
   * report with it. Missing a dialog by a few pixels is an ordinary thing to do,
   * so the whole window refuses file drops while one is open.
   */
  enabled?: boolean;
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
  /**
   * Take a picture of the app itself and attach it, replacing any current one.
   *
   * The same state machine as {@link attach} — one image, the newest attempt
   * wins — so a capture and a paste racing each other cannot both land.
   */
  capture: () => Promise<void>;
  /**
   * Take a picture of the app and attach only the part of it showing one
   * element, replacing any current one.
   *
   * The same single capture as {@link capture} with a crop on the end, and the
   * same state machine — one image, the newest attempt wins.
   *
   * @param element - The element the person pointed at.
   */
  captureElement: (element: Element) => Promise<void>;
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
  const { onFileDragIn, onAttached, enabled = false } = options;
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  // `dragenter`/`dragleave` also fire crossing every child boundary, so the
  // depth — not the last event — is what says whether the pointer is still
  // inside. A plain boolean flickers off the moment the drag crosses a label.
  const dragDepth = useRef(0);

  // Which attach attempt is the live one. Compression is async, so a second
  // attach, a remove, or a dialog reopen can all land while an earlier one is
  // still encoding; without this the older promise wins on resolve, and it wins
  // by writing an image nobody asked for any more.
  const generation = useRef(0);

  /**
   * Run one attach attempt to its end, whatever produced the picture.
   *
   * The single owner of the in-flight flag and the generation counter, so every
   * way in — a picked file, a paste, a drop, a one-click capture — obeys the
   * same "newest attempt wins" rule. A second state machine beside this one is
   * how two paths end up both writing an image.
   */
  const attachFrom = useCallback(
    async (produce: () => Promise<string>): Promise<void> => {
      const mine = ++generation.current;
      setIsPreparing(true);
      try {
        const compressed = await produce();
        // Superseded while working: the image was removed, the dialog was
        // reopened, or a second picture is already on its way. Any of the three
        // makes this result stale, and writing it would resurrect something the
        // user believed was gone.
        if (mine !== generation.current) return;
        setDataUrl(compressed);
        onAttached?.();
      } catch (error) {
        if (mine !== generation.current) return;
        toast.error(refusalMessage(error));
      } finally {
        // Only the live attempt owns the flag; a stale one clearing it would
        // re-enable Send while the newer picture is still encoding.
        if (mine === generation.current) setIsPreparing(false);
      }
    },
    [onAttached]
  );

  const attach = useCallback(
    async (file: File): Promise<void> => {
      if (!file.type.startsWith('image/')) {
        toast.error(NOT_AN_IMAGE_MESSAGE);
        return;
      }
      await attachFrom(() => compressImage(file));
    },
    [attachFrom]
  );

  const capture = useCallback(
    // Compressed like every other picture: the shell hands back a full-size PNG
    // of a retina window, which is several times the size the wire accepts.
    (): Promise<void> => attachFrom(async () => compressImage(await captureAppView())),
    [attachFrom]
  );

  const captureElement = useCallback(
    // `cropShotToElement` owns the compression too — cropping first is what makes
    // the bound worth spending on the part someone pointed at rather than on a
    // whole window that happens to contain it.
    (element: Element): Promise<void> =>
      attachFrom(async () => cropShotToElement(await captureAppShot(), element)),
    [attachFrom]
  );

  const clear = useCallback(() => {
    generation.current += 1;
    setDataUrl(null);
    setIsPreparing(false);
  }, []);

  const reset = useCallback((initial?: string) => {
    generation.current += 1;
    dragDepth.current = 0;
    // An image handed in by a caller never passed through `compressImage`, so
    // this is the only place its bounds are checked. Dropping it is the safe
    // failure: an over-cap or non-image value would otherwise be refused at
    // intake, far from whoever could fix it.
    if (initial !== undefined && !isAcceptableImageDataUrl(initial)) {
      console.warn(
        '[feedback] Ignoring an initial screenshot that is not a bounded image data URL.'
      );
      setDataUrl(null);
    } else {
      setDataUrl(initial ?? null);
    }
    setIsPreparing(false);
    setIsDraggingOver(false);
  }, []);

  // Swallow file drops that land anywhere but the dialog. Without this the
  // browser navigates away to the dropped file and the typed report is gone —
  // the desktop shell blocks that with `will-navigate`, but the web app has no
  // such backstop. Registered only while a dialog that takes images is open, so
  // dropping a file on the app at any other time behaves as it always has.
  useEffect(() => {
    if (!enabled) return;
    const swallow = (event: globalThis.DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer)) return;
      event.preventDefault();
    };
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, [enabled]);

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
    capture,
    captureElement,
    clear,
    reset,
    handlers: { onPaste, onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
