import { useEffect, useState } from 'react';

/** Visible vertical space for fixed sheets, following phone keyboards and viewport panning. */
export function useVisualViewportBounds(): { top: number; height: number } {
  const [bounds, setBounds] = useState(readBounds);
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      const next = readBounds();
      setBounds((previous) =>
        previous.top === next.top && previous.height === next.height ? previous : next
      );
    };
    window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
    };
  }, []);
  return bounds;
}

/** Pinch zoom retains normal layout positioning; keyboards use the visible viewport bounds. */
function readBounds(): { top: number; height: number } {
  if (typeof window === 'undefined') return { top: 0, height: 0 };
  const viewport = window.visualViewport;
  return viewport && viewport.scale <= 1
    ? { top: Math.max(0, viewport.offsetTop), height: viewport.height }
    : { top: 0, height: window.innerHeight };
}
