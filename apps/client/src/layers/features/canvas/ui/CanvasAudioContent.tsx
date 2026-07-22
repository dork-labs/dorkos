import { useMemo } from 'react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { resolveCanvasFetchUrl } from '../lib/fetch-src';

interface CanvasAudioContentProps {
  /** Audio canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'audio' }>;
}

/**
 * Audio canvas renderer: resolves the source to a cwd-confined (or remote) URL
 * and plays it in the browser's native `<audio controls>` element, centered on a
 * muted, theme-aware backdrop. Local files stream through the raw route, which
 * serves HTTP Range so seeking works. When the source can't be resolved (a
 * blocked scheme, or a local file the transport can't serve), a graceful in-tab
 * message replaces the player rather than a broken control.
 */
export function CanvasAudioContent({ content }: CanvasAudioContentProps) {
  const transport = useTransport();
  const cwd = useAppStore((s) => s.selectedCwd);

  const resolved = useMemo(
    () => resolveCanvasFetchUrl(content.src, (p) => transport.mediaUrl(cwd ?? '', p)),
    [content.src, transport, cwd]
  );

  const label = content.title ?? 'Canvas audio';

  if (resolved.url === null) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-8 text-center">
        <p>This audio can&rsquo;t be played here.</p>
      </div>
    );
  }

  return (
    <div className="bg-muted/40 flex h-full w-full items-center justify-center p-8">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- user media, no caption track available */}
      <audio controls src={resolved.url} aria-label={label} className="w-full max-w-2xl">
        <p className="text-muted-foreground text-sm">
          Your browser can&rsquo;t play this audio.{' '}
          <a href={resolved.url} className="text-foreground underline underline-offset-4">
            Download {label}
          </a>
          .
        </p>
      </audio>
    </div>
  );
}
