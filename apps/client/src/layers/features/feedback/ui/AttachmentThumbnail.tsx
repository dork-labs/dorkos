import { Crosshair, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';

interface AttachmentThumbnailProps {
  /** The picture that will be sent, or nothing when this attachment has no picture of its own. */
  imageUrl?: string;
  /** What the picture shows, for a screen reader. Also the visible caption when `caption` is absent. */
  alt: string;
  /** A short caption over the bottom of the thumbnail ("Message list"). */
  caption?: string;
  /** Marks the thumbnail as a pointed-at element, with the crosshair beside its caption. */
  pointed?: boolean;
  /**
   * Extra detail shown on hover and focus of an openable thumbnail: the
   * element's selector, for one that was pointed at.
   */
  detail?: string;
  /** Open the full preview. Absent for an attachment with no picture to preview. */
  onOpen?: () => void;
  /** Take this attachment off the report. */
  onRemove: () => void;
  /** The remove button's accessible name, which says WHICH attachment it removes. */
  removeLabel: string;
}

/**
 * One small attachment inside the feedback message box: the screenshot, or the
 * element the person pointed at, captioned with a name they can read.
 *
 * It is a thumbnail, not the picture itself, because the message is the point of
 * the form. The full picture is one click away in the preview, and the remove
 * button is labelled for what it removes, so two thumbnails side by side are
 * never two buttons both called "Remove".
 */
export function AttachmentThumbnail({
  imageUrl,
  alt,
  caption,
  pointed = false,
  detail,
  onOpen,
  onRemove,
  removeLabel,
}: AttachmentThumbnailProps) {
  const face = (
    <>
      {imageUrl ? (
        <img src={imageUrl} alt={alt} className="size-full object-cover" />
      ) : (
        <span className="text-muted-foreground flex size-full items-center justify-center">
          <Crosshair className="size-4" aria-hidden />
        </span>
      )}
      {caption && (
        <span className="bg-background/85 absolute inset-x-0 bottom-0 flex items-center gap-1 truncate px-1.5 py-0.5 text-left text-[11px] leading-tight">
          {pointed && <Crosshair className="size-3 shrink-0" aria-hidden />}
          <span className="truncate">{caption}</span>
        </span>
      )}
    </>
  );

  const body = onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${alt.charAt(0).toLowerCase()}${alt.slice(1)}`}
      className="focus-visible:ring-ring relative block size-full overflow-hidden rounded-[inherit] focus-visible:ring-2 focus-visible:outline-none"
    >
      {face}
    </button>
  ) : (
    <div
      role="img"
      aria-label={alt}
      className="relative size-full overflow-hidden rounded-[inherit]"
    >
      {face}
    </div>
  );

  return (
    <div className="bg-muted/40 relative h-16 w-28 shrink-0 rounded-md border">
      {/* Only an openable thumbnail is a control, so only it carries the tooltip:
          one on a plain picture would be reachable by hover alone. */}
      {detail && onOpen ? (
        <Tooltip>
          <TooltipTrigger asChild>{body}</TooltipTrigger>
          <TooltipContent className="max-w-72 font-mono text-[11px] break-all">
            {detail}
          </TooltipContent>
        </Tooltip>
      ) : (
        body
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="bg-background/90 text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute top-1 right-1 flex size-5 items-center justify-center rounded-full border transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none"
      >
        <X className="size-3" aria-hidden />
      </button>
    </div>
  );
}
