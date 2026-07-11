import * as React from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { X, PictureInPicture2 } from 'lucide-react';
import { cn } from '../lib';

/** Viewport margin (px) kept clear on every edge when clamping. */
const VIEWPORT_MARGIN = 16;
const DEFAULT_MIN_WIDTH = 280;
const DEFAULT_MIN_HEIGHT = 180;

/** Position and size of a floating panel, in CSS pixels relative to the viewport. */
export interface FloatingPanelGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Props for {@link FloatingPanel}. Geometry is fully controlled by the host. */
export interface FloatingPanelProps {
  title: string;
  geometry: FloatingPanelGeometry;
  onGeometryChange: (g: FloatingPanelGeometry) => void;
  onClose: () => void;
  /** Renders a restore control when provided (e.g. "send back inline"). */
  onRestore?: () => void;
  minWidth?: number; // default 280
  minHeight?: number; // default 180
  children: React.ReactNode;
  className?: string;
}

/**
 * Constrain a geometry so the panel stays fully reachable inside the viewport.
 *
 * Size is capped to at least `minWidth`/`minHeight` and at most the viewport
 * minus an 8px-per-edge margin; position is then clamped so the panel never
 * escapes the viewport edges.
 *
 * @param geometry - The proposed geometry to constrain.
 * @param minWidth - Smallest allowed width.
 * @param minHeight - Smallest allowed height.
 * @returns The clamped geometry.
 */
export function clampGeometry(
  geometry: FloatingPanelGeometry,
  minWidth: number,
  minHeight: number
): FloatingPanelGeometry {
  const maxWidth = Math.max(minWidth, window.innerWidth - VIEWPORT_MARGIN);
  const maxHeight = Math.max(minHeight, window.innerHeight - VIEWPORT_MARGIN);
  const width = Math.min(Math.max(geometry.width, minWidth), maxWidth);
  const height = Math.min(Math.max(geometry.height, minHeight), maxHeight);
  const x = Math.min(Math.max(geometry.x, 0), Math.max(0, window.innerWidth - width));
  const y = Math.min(Math.max(geometry.y, 0), Math.max(0, window.innerHeight - height));
  return { x, y, width, height };
}

function geometriesDiffer(a: FloatingPanelGeometry, b: FloatingPanelGeometry): boolean {
  return a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height;
}

/**
 * Presentational floating panel: a draggable, resizable window portalled above
 * ordinary content (below the modal layer). It owns gesture mechanics only —
 * geometry lives entirely in props, and the host decides what content and
 * restore affordance to render. Writes geometry back exactly once per gesture,
 * on pointer release, so persisting hosts never see mid-drag churn.
 *
 * Escape does not close the panel by design (it is non-modal, ideation D8).
 *
 * @param props - See {@link FloatingPanelProps}.
 */
export function FloatingPanel(props: FloatingPanelProps): React.ReactNode {
  const {
    title,
    geometry,
    onGeometryChange,
    onClose,
    onRestore,
    minWidth,
    minHeight,
    children,
    className,
  } = props;

  const containerRef = React.useRef<HTMLDivElement>(null);
  const minW = minWidth ?? DEFAULT_MIN_WIDTH;
  const minH = minHeight ?? DEFAULT_MIN_HEIGHT;

  // Re-clamp on mount (self-corrects a stale persisted geometry the instant the
  // panel first renders) and whenever the viewport resizes while mounted.
  React.useEffect(() => {
    const reclamp = () => {
      const clamped = clampGeometry(geometry, minW, minH);
      if (geometriesDiffer(clamped, geometry)) onGeometryChange(clamped);
    };
    reclamp();
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
  }, [geometry, minW, minH, onGeometryChange]);

  // Shared document-listener gesture: apply the live delta imperatively to the
  // container (rAF-throttled) and commit the clamped result once on release.
  const beginGesture = React.useCallback(
    (
      e: React.PointerEvent,
      compute: (dx: number, dy: number, start: FloatingPanelGeometry) => FloatingPanelGeometry
    ) => {
      e.preventDefault();
      const el = containerRef.current;
      if (!el) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const start = geometry;
      let latest = start;
      let rafId = 0;

      const apply = () => {
        rafId = 0;
        el.style.left = `${latest.x}px`;
        el.style.top = `${latest.y}px`;
        el.style.width = `${latest.width}px`;
        el.style.height = `${latest.height}px`;
      };

      const onMove = (ev: PointerEvent) => {
        latest = compute(ev.clientX - startX, ev.clientY - startY, start);
        if (!rafId) rafId = requestAnimationFrame(apply);
      };

      const onUp = () => {
        if (rafId) cancelAnimationFrame(rafId);
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        onGeometryChange(clampGeometry(latest, minW, minH));
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    },
    [geometry, minW, minH, onGeometryChange]
  );

  const handleHeaderPointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      // Let clicks on the icon controls behave as buttons, not drag starts.
      if ((e.target as HTMLElement).closest('button')) return;
      beginGesture(e, (dx, dy, start) => ({ ...start, x: start.x + dx, y: start.y + dy }));
    },
    [beginGesture]
  );

  const handleResizePointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      beginGesture(e, (dx, dy, start) => ({
        ...start,
        width: Math.max(minW, start.width + dx),
        height: Math.max(minH, start.height + dy),
      }));
    },
    [beginGesture, minW, minH]
  );

  return createPortal(
    <motion.div
      ref={containerRef}
      data-slot="floating-panel"
      role="complementary"
      aria-label={title}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
      style={{ left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height }}
      className={cn(
        'bg-card border-border shadow-floating fixed z-40 flex flex-col overflow-hidden rounded-lg border',
        className
      )}
    >
      <div
        onPointerDown={handleHeaderPointerDown}
        className="border-border flex cursor-grab items-center gap-1 border-b px-3 py-2 select-none active:cursor-grabbing"
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {onRestore ? (
          <button
            type="button"
            aria-label="Restore"
            onClick={onRestore}
            className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring inline-flex items-center justify-center rounded-md p-1 transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <PictureInPicture2 className="size-(--size-icon-sm)" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring inline-flex items-center justify-center rounded-md p-1 transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <X className="size-(--size-icon-sm)" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">{children}</div>

      <div
        aria-hidden
        onPointerDown={handleResizePointerDown}
        className="absolute right-0 bottom-0 size-4 cursor-nwse-resize"
      />
    </motion.div>,
    document.body
  );
}
