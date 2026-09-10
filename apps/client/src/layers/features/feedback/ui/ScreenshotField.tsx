import { useId, type ChangeEvent } from 'react';
import { ImagePlus, Crosshair, X } from 'lucide-react';
import { Label } from '@/layers/shared/ui';
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
  /** Drop the attached image. */
  onRemove: () => void;
  /** Open the full preview on its Screenshot tab. */
  onPreview: () => void;
  /** Whether this is a touch surface — changes the wording and hides "Point at element". */
  isMobile: boolean;
}

/**
 * The screenshot slot in the feedback dialog's attachments panel.
 *
 * Three ways in, one image out. On a pointer surface the whole dialog takes a
 * paste or a drop and this box is where the drag lands; on a touch surface the
 * same box opens the photo picker, which is the only one of the three a touch
 * keyboard can offer. Once something is attached the box becomes the picture
 * itself — the promise of "you see exactly what will be sent" is only kept if
 * the thing is on screen, and that holds while a REPLACEMENT is encoding too.
 *
 * "Point at element" is still the roadmap affordance it has always been, shown
 * only on desktop because it is a pointer gesture that will never ship on touch.
 */
export function ScreenshotField({
  dataUrl,
  isPreparing,
  isDraggingOver,
  onPick,
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

      {!isMobile && (
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs opacity-70">
          <Crosshair className="size-3.5" aria-hidden />
          Point at element (coming soon)
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        You pick the image and see it here before you send. Nothing is captured on its own.
      </p>
    </div>
  );
}
