import { useMemo, useState } from 'react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { resolveCanvasMediaSrc, canvasMediaErrorMessage } from '../lib/media-src';

interface CanvasImageContentProps {
  /** Image canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'image' }>;
}

/** Load lifecycle for the image element. */
type LoadState = 'loading' | 'loaded' | 'error';

/**
 * Whether the resolved URL is safe to offer as a click-to-open-full-size link.
 *
 * Defense in depth: an SVG data URI opened as a top-level document would run in
 * a scripting context (unlike `<img>` rendering, which never executes scripts).
 * Modern browsers already block top-level `data:` navigation, but we exclude
 * SVG data URIs from the click-through anyway so the affordance never depends
 * on that browser behavior. Raster data URIs and regular URLs are fine.
 */
function isZoomableUrl(url: string): boolean {
  return !url.toLowerCase().startsWith('data:image/svg');
}

/**
 * Image canvas renderer: object-contained on a muted, theme-aware backdrop,
 * with loading and error states. Clicking the image opens it full size in a
 * new tab (except SVG data URIs — see {@link isZoomableUrl}).
 */
export function CanvasImageContent({ content }: CanvasImageContentProps) {
  const transport = useTransport();
  const cwd = useAppStore((s) => s.selectedCwd);

  const resolved = useMemo(
    () => resolveCanvasMediaSrc(content.src, 'image', (p) => transport.mediaUrl(cwd ?? '', p)),
    [content.src, transport, cwd]
  );

  const [loadState, setLoadState] = useState<LoadState>('loading');
  // Reset the load lifecycle when the source changes (e.g. update_canvas swaps
  // a failed image for a valid one) — otherwise a past error would stick to the
  // new image. Render-time reset per React's "storing information from previous
  // renders" pattern; the component is not keyed by src.
  const [prevSrc, setPrevSrc] = useState(content.src);
  if (prevSrc !== content.src) {
    setPrevSrc(content.src);
    setLoadState('loading');
  }

  const alt = content.alt ?? content.title ?? 'Canvas image';

  if (resolved.url === null) {
    const message = resolved.error ? canvasMediaErrorMessage(resolved.error, 'image') : '';
    return <MediaMessage>{message}</MediaMessage>;
  }

  const url = resolved.url;

  return (
    <div className="bg-muted/40 relative flex h-full items-center justify-center p-4">
      {loadState === 'loading' && (
        <p className="text-muted-foreground absolute text-sm" aria-live="polite">
          Loading image…
        </p>
      )}
      {loadState === 'error' ? (
        <MediaMessage>This image couldn&rsquo;t be loaded.</MediaMessage>
      ) : (
        <MaybeZoomLink url={url} alt={alt}>
          <img
            src={url}
            alt={alt}
            onLoad={() => setLoadState('loaded')}
            onError={() => setLoadState('error')}
            className={cn(
              'max-h-full max-w-full object-contain transition-opacity',
              loadState === 'loaded' ? 'opacity-100' : 'opacity-0'
            )}
          />
        </MaybeZoomLink>
      )}
    </div>
  );
}

/** Wraps the image in an open-full-size link when the URL is safe to navigate to. */
function MaybeZoomLink({
  url,
  alt,
  children,
}: {
  url: string;
  alt: string;
  children: React.ReactNode;
}) {
  if (!isZoomableUrl(url)) {
    return <div className="flex max-h-full max-w-full">{children}</div>;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="focus-ring flex max-h-full max-w-full rounded-md"
      aria-label={`Open ${alt} full size in a new tab`}
    >
      {children}
    </a>
  );
}

/** Centered muted message for empty/error media states. */
function MediaMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center p-8 text-center">
      <p>{children}</p>
    </div>
  );
}
