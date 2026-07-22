import { useMemo } from 'react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { resolveCanvasFetchUrl } from '../lib/fetch-src';

interface CanvasVideoContentProps {
  /** Video canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'video' }>;
}

/**
 * Video canvas renderer: resolves the source to a cwd-confined (or remote) URL
 * and plays it in the browser's native `<video controls>` element, object-fit
 * contained on a muted, theme-aware backdrop. Local files stream through the raw
 * route, which serves HTTP Range so seeking works. When the source can't be
 * resolved (a blocked scheme, or a local file the transport can't serve), a
 * graceful in-tab message replaces the player rather than a broken frame.
 */
export function CanvasVideoContent({ content }: CanvasVideoContentProps) {
  const transport = useTransport();
  const cwd = useAppStore((s) => s.selectedCwd);

  const resolved = useMemo(
    () => resolveCanvasFetchUrl(content.src, (p) => transport.mediaUrl(cwd ?? '', p)),
    [content.src, transport, cwd]
  );

  const label = content.title ?? 'Canvas video';

  if (resolved.url === null) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-8 text-center">
        <p>This video can&rsquo;t be played here.</p>
      </div>
    );
  }

  return (
    <div className="bg-muted/40 flex h-full w-full items-center justify-center">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- user media, no caption track available */}
      <video
        controls
        src={resolved.url}
        aria-label={label}
        className="max-h-full w-full max-w-full object-contain"
      >
        <p className="text-muted-foreground p-8 text-sm">
          Your browser can&rsquo;t play this video.{' '}
          <a href={resolved.url} className="text-foreground underline underline-offset-4">
            Download {label}
          </a>
          .
        </p>
      </video>
    </div>
  );
}
