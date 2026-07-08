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
 * Image canvas renderer: object-contained on a checkerboard backdrop (so
 * transparency reads in both themes), with loading and error states. Clicking
 * the image opens it full size in a new tab.
 */
export function CanvasImageContent({ content }: CanvasImageContentProps) {
  const transport = useTransport();
  const cwd = useAppStore((s) => s.selectedCwd);

  const resolved = useMemo(
    () => resolveCanvasMediaSrc(content.src, 'image', (p) => transport.mediaUrl(cwd ?? '', p)),
    [content.src, transport, cwd]
  );

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const alt = content.alt ?? content.title ?? 'Canvas image';

  if (resolved.url === null) {
    const message = resolved.error ? canvasMediaErrorMessage(resolved.error, 'image') : '';
    return <MediaMessage>{message}</MediaMessage>;
  }

  const url = resolved.url;

  return (
    <div className="bg-muted/40 flex h-full items-center justify-center p-4">
      {loadState === 'loading' && (
        <p className="text-muted-foreground absolute text-sm" aria-live="polite">
          Loading image…
        </p>
      )}
      {loadState === 'error' ? (
        <MediaMessage>This image couldn&rsquo;t be loaded.</MediaMessage>
      ) : (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="focus-ring flex max-h-full max-w-full rounded-md"
          aria-label={`Open ${alt} full size in a new tab`}
        >
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
        </a>
      )}
    </div>
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
