import { useId, type ChangeEvent } from 'react';
import { ImagePlus, Camera, Crosshair, X } from 'lucide-react';
import { Button, Label } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

interface ScreenshotFieldProps {
  /** The compressed image that will be sent, or `null` when none is attached. */
  dataUrl: string | null;
  /** True while a picked image is being downscaled and encoded. */
  isPreparing: boolean;
  /** True while a file drag is over the dialog, for the drag-over treatment. */
  isDraggingOver: boolean;
  /** Attach a file the user picked from the file input. */
  onPick: (file: File) => void;
  /** Take a picture of the app itself and attach it. */
  onCapture: () => void;
  /** Step out of the dialog and let the user aim at one element. */
  onPointAtElement: () => void;
  /** Drop the attached image. */
  onRemove: () => void;
  /** Open the full preview on its Screenshot tab. */
  onPreview: () => void;
  /**
   * Whether the viewport is below the mobile breakpoint (768px) — changes the
   * wording and hides "Point at element". A narrow desktop window counts, which
   * is the honest reading of the media query behind it.
   */
  isMobile: boolean;
}

/**
 * The screenshot slot in the feedback dialog's attachments panel.
 *
 * Four ways in, one image out. On a pointer surface the whole dialog takes a
 * paste or a drop and this box is where the drag lands; on a touch surface the
 * same box opens the photo picker, which is the only one of those three a touch
 * keyboard can offer. "Capture app view" is the fourth and the easiest — one
 * click and the picture is of the app — and it is offered on every surface,
 * because a phone can render its own DOM as well as a laptop can. Once
 * something is attached the box becomes the picture itself — the promise of
 * "you see exactly what will be sent" is only kept if the thing is on screen,
 * and that holds while a REPLACEMENT is encoding too.
 *
 * "Point at element" is the fifth and the most precise: aim at the thing that
 * looks wrong and the report arrives cropped to it. Offered only on a wide
 * viewport, and `isMobile` is honestly named for what it measures — a 768px
 * media query, not a device. That is the gate the spec chose (decision 7,
 * `useIsMobile()`), and it is the right SHAPE of gate even though it is not the
 * exact question: hovering to aim needs both a pointer and room to see the app
 * you are aiming at, and a window narrow enough to trip that query has neither
 * to spare. A narrow desktop window therefore loses the affordance too, which
 * costs a person one drag of a window edge. Hidden rather than disabled, since a
 * control a surface is not offering is not a control that surface should be
 * looking at.
 */
export function ScreenshotField({
  dataUrl,
  isPreparing,
  isDraggingOver,
  onPick,
  onCapture,
  onPointAtElement,
  onRemove,
  onPreview,
  isMobile,
}: ScreenshotFieldProps) {
  // Generated, not a module constant: the Dev Playground mounts three of these
  // dialogs at once, and a shared id would point every label at the first input.
  const fileInputId = useId();

  function onInputChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    // Clear the input so picking the SAME file twice in a row still fires a
    // change event (the second pick is otherwise a no-op).
    event.target.value = '';
    if (file) onPick(file);
  }

  const pickLabel = isMobile ? 'Add a photo' : 'Add screenshot';
  // Only the pointer surface gets a hint. On touch the label already says the
  // whole of it, and the three ways in are two ways a touch device does not have.
  const pickHint = isMobile ? null : 'Drop one here, paste one, or browse your files.';

  function emptyStateLabel(): string {
    if (isPreparing) return 'Getting it ready…';
    if (isDraggingOver) return 'Drop to attach';
    return pickLabel;
  }

  return (
    <div className="flex flex-col gap-2">
      {dataUrl ? (
        <div className="flex flex-col gap-2 rounded-md border p-2.5">
          <img
            src={dataUrl}
            alt="The screenshot you attached"
            className="bg-muted/30 max-h-40 w-full rounded-sm object-contain"
          />
          {isPreparing && (
            <p role="status" aria-live="polite" className="text-muted-foreground text-xs">
              Getting it ready…
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={onPreview}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm text-xs underline underline-offset-2 transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none"
            >
              View full screenshot
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex items-center gap-1 rounded-sm text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none"
            >
              <X className="size-3.5" aria-hidden />
              Remove screenshot
            </button>
          </div>
        </div>
      ) : (
        <Label
          htmlFor={fileInputId}
          className={cn(
            'focus-within:ring-ring flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed px-3 py-4 text-center transition-colors duration-150 focus-within:ring-2',
            isDraggingOver
              ? 'border-primary bg-primary/5 text-foreground'
              : 'border-muted-foreground/25 text-muted-foreground hover:border-muted-foreground/50'
          )}
        >
          <span
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 text-xs font-medium"
          >
            <ImagePlus className="size-4" aria-hidden />
            {emptyStateLabel()}
          </span>
          {pickHint && !isPreparing && !isDraggingOver && (
            <span className="text-muted-foreground text-xs font-normal">{pickHint}</span>
          )}
          <input
            id={fileInputId}
            type="file"
            accept="image/*"
            aria-label={pickLabel}
            className="sr-only"
            onChange={onInputChange}
          />
        </Label>
      )}

      {/* One click, and the picture is of the app — the only path here that
          needs no file, no photo library and no aim. It stays on offer with an
          image already attached, where it replaces that one, because "capture
          it again now that the bug is on screen" is the common second act. */}
      <div className="flex flex-col gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCapture}
          disabled={isPreparing}
          className="w-full text-xs"
        >
          <Camera className="size-3.5" aria-hidden />
          Capture app view
        </Button>
        <p className="text-muted-foreground text-xs">
          Captures only the app — never the rest of your screen.
        </p>
      </div>

      {/* The most precise way in, and the only one that needs the dialog out of
          the way: it steps aside, the person aims at the thing that looks wrong,
          and the report comes back cropped to it. */}
      {!isMobile && (
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onPointAtElement}
            disabled={isPreparing}
            className="w-full text-xs"
          >
            <Crosshair className="size-3.5" aria-hidden />
            Point at element
          </Button>
          <p className="text-muted-foreground text-xs">
            Click the part that looks wrong. We’ll crop the picture to it.
          </p>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        You choose what to attach and see it here before you send. Nothing is captured on its own.
      </p>
    </div>
  );
}
