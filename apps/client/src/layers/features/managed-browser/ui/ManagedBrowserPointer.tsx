import { useMemo, useSyncExternalStore, type CSSProperties } from 'react';
import type { BrowserPixelPresentation } from '@/layers/entities/browser';
import {
  BrowserFramePointerEnvelopeSchema,
  BrowserViewerSchema,
  type BrowserViewer,
} from '@dorkos/shared/browser-schemas';

export interface ManagedBrowserPointerProps {
  presentation?: BrowserPixelPresentation;
  viewer?: BrowserViewer;
}

/** Read the external wall clock through React's snapshot/commit consistency protocol.
 * Clock changes only remove a visual; this does not renew a viewer or grant permission. */
function viewerExpiryStore(expires: number) {
  return {
    getSnapshot: () => Number.isFinite(expires) && expires > Date.now(),
    subscribe(notify: () => void) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const check = () => {
        if (!Number.isFinite(expires)) return;
        const remaining = expires - Date.now();
        if (remaining <= 0) notify();
        else timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
      };
      // Also closes the gap when expiry crosses between render and subscription.
      check();
      return () => clearTimeout(timer);
    },
  };
}

/** Display-only marker. The parent positions this overlay over the exact canvas content box. */
export function ManagedBrowserPointer({ presentation, viewer }: ManagedBrowserPointerProps) {
  const expires = viewer ? Date.parse(viewer.expiresAt) : Number.NaN;
  const clock = useMemo(() => viewerExpiryStore(expires), [expires]);
  const live = useSyncExternalStore(clock.subscribe, clock.getSnapshot, () => false);

  if (!presentation || !viewer || !live) return null;
  let position: CSSProperties | undefined;
  try {
    const current = BrowserViewerSchema.parse(viewer);
    const metadata = BrowserFramePointerEnvelopeSchema.parse({
      frame: presentation.frame,
      geometry: presentation.geometry,
      pointer: presentation.pointer,
    });
    const { pointer, frame, geometry } = metadata;
    if (
      !pointer ||
      current.viewerId !== frame.viewerId ||
      (Object.keys(frame.binding) as (keyof typeof frame.binding)[]).some(
        (key) => current.binding[key] !== frame.binding[key]
      )
    )
      return null;
    position = {
      left: `${(pointer.x / geometry.cssViewport.width) * 100}%`,
      top: `${(pointer.y / geometry.cssViewport.height) * 100}%`,
      // Align the SVG's (0,0) tip, including its 2px stroke inset, to the observed point.
      transform: 'translate(-2px, -2px)',
    };
  } catch {
    // Unavailable or malformed visual metadata never keeps a previous marker visible.
    return null;
  }
  if (!position) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <svg
        data-testid="managed-browser-pointer"
        className="text-foreground absolute h-6 w-6 drop-shadow-sm"
        style={position}
        viewBox="-2 -2 24 24"
        fill="currentColor"
        stroke="hsl(var(--background))"
        strokeWidth="1.5"
        strokeLinejoin="round"
      >
        <path d="M0 0 6 20 10 12 18 9Z" />
      </svg>
    </div>
  );
}
