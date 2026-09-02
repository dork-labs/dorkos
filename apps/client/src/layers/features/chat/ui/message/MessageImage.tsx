import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import type { ImagePart } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';

/**
 * A picture the agent produced, rendered where it happened in the transcript.
 *
 * **Inline in the bubble rather than on the canvas, deliberately.** The canvas
 * is for opening files a session TOUCHED — you go there to inspect something.
 * A generated image is part of what the agent said, so it belongs in reading
 * order beside the sentence that introduced it, the same way a tool card does.
 * The canvas remains the right home for a full-size view later; sending the
 * picture there instead would have made "look at what I made" a navigation.
 *
 * The bytes are fetched by the browser from `part.url` and cached there. This
 * component never holds them, which is the same rule the part, the event and
 * the stream buffers follow — see `sessionImageShape` in `@dorkos/shared`.
 *
 * @param part - The image part to render.
 */
export function MessageImage({ part }: { part: ImagePart }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    // Honest rather than empty. A picture that will not load is exactly the
    // silent nothing this feature exists to end, so it says so.
    return (
      <div
        data-testid="message-image-missing"
        className={cn(
          'my-3 flex items-center gap-2 rounded-md border px-3 py-2',
          'text-muted-foreground border-border/60 bg-muted/30 text-sm'
        )}
      >
        <ImageOff aria-hidden="true" className="size-4 shrink-0" />
        <span>{part.alt ? `${part.alt} — not available` : 'This image is not available.'}</span>
      </div>
    );
  }

  return (
    <figure className="my-3" data-testid="message-image">
      <a
        href={part.url}
        target="_blank"
        rel="noreferrer"
        // Opening the raw bytes in a tab is the full-size view. Safe because the
        // route serves only raster images with `nosniff` and refuses SVG
        // outright, so a top-level navigation to one cannot execute anything.
        className="focus-visible:ring-ring block rounded-md focus-visible:ring-2 focus-visible:outline-none"
      >
        <img
          src={part.url}
          alt={part.alt ?? 'Image produced by the agent'}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="border-border/60 bg-muted/20 max-h-[32rem] max-w-full rounded-md border object-contain"
        />
      </a>
    </figure>
  );
}
