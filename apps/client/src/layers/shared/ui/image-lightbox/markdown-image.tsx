/**
 * The `img` a Markdown body draws: a thumbnail that opens the lightbox.
 *
 * @module shared/ui/image-lightbox/markdown-image
 */
import { useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { cn } from '@/layers/shared/lib/utils';
import { ImageLightboxTrigger } from './image-lightbox-group';

/** What Streamdown hands an `img` override, plus the hast node it never needs. */
export type MarkdownImageProps = ComponentProps<'img'> & { node?: unknown };

/**
 * A picture written in Markdown (`![alt](src)`), opening the lightbox on click.
 *
 * **Except inside a link.** `[![badge](img)](url)` is a picture that IS a link,
 * and a button inside an `<a>` is invalid HTML that would also steal the click
 * the author meant for the link. The thumbnail cannot know its parent when it
 * renders, so it looks once it is on the page, before the browser paints, and
 * draws a plain `<img>` there instead.
 *
 * A picture that will not load says so in a quiet line, the way Streamdown's own
 * image did, rather than a broken-image glyph you could still click to open.
 */
export function MarkdownImage({ node: _node, className, src, alt, ...rest }: MarkdownImageProps) {
  const probe = useRef<HTMLImageElement>(null);
  const [inLink, setInLink] = useState(false);
  const [failed, setFailed] = useState(false);

  useLayoutEffect(() => {
    if (probe.current?.parentElement?.closest('a')) setInLink(true);
  }, []);

  if (failed) {
    return (
      <span className="text-muted-foreground bg-muted/40 inline-block rounded-md px-2 py-1 text-xs">
        {alt ? `${alt}, not available` : 'Image not available'}
      </span>
    );
  }

  const img = (
    <img
      ref={probe}
      src={src}
      alt={alt ?? ''}
      loading="lazy"
      decoding="async"
      {...rest}
      onError={() => setFailed(true)}
      className={cn('max-h-[32rem] max-w-full rounded-md', className)}
    />
  );

  if (inLink || typeof src !== 'string' || src === '') return img;
  return (
    <ImageLightboxTrigger image={{ src, alt: alt ?? '' }} className="my-1 inline-block">
      {img}
    </ImageLightboxTrigger>
  );
}
