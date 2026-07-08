import { useMemo, useState } from 'react';
import { TransformWrapper, TransformComponent, useControls } from 'react-zoom-pan-pinch';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
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
 * Image canvas renderer: object-contained on a muted, theme-aware backdrop,
 * with loading and error states. The image sits in a pan/zoom surface
 * (scroll-to-zoom, drag-to-pan, double-click-to-zoom) with a small control
 * cluster for zoom in/out and reset-to-fit.
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
    <div className="bg-muted/40 relative flex h-full items-center justify-center">
      {loadState === 'loading' && (
        <p className="text-muted-foreground absolute text-sm" aria-live="polite">
          Loading image…
        </p>
      )}
      {loadState === 'error' ? (
        <MediaMessage>This image couldn&rsquo;t be loaded.</MediaMessage>
      ) : (
        <TransformWrapper centerOnInit doubleClick={{ mode: 'toggle' }} wheel={{ step: 0.15 }}>
          <ZoomControls />
          <TransformComponent
            wrapperClass="!h-full !w-full"
            contentClass="!h-full !w-full flex items-center justify-center"
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
          </TransformComponent>
        </TransformWrapper>
      )}
    </div>
  );
}

/** Zoom in / out / reset controls, rendered inside the transform context. */
function ZoomControls() {
  const { zoomIn, zoomOut, resetTransform } = useControls();
  return (
    <div className="absolute top-2 right-2 z-10 flex gap-1">
      <ZoomButton label="Zoom in" onClick={() => zoomIn()}>
        <ZoomIn className="size-4" />
      </ZoomButton>
      <ZoomButton label="Zoom out" onClick={() => zoomOut()}>
        <ZoomOut className="size-4" />
      </ZoomButton>
      <ZoomButton label="Reset zoom" onClick={() => resetTransform()}>
        <Maximize className="size-4" />
      </ZoomButton>
    </div>
  );
}

/** A single zoom-control button. */
function ZoomButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="bg-background/80 text-muted-foreground hover:text-foreground focus-ring rounded-md border p-1.5 backdrop-blur transition-colors"
    >
      {children}
    </button>
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
