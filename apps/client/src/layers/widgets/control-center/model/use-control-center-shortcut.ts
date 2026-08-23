import { useEffect } from 'react';
import { useAppStore } from '@/layers/shared/model';

/**
 * Registers the keyboard shortcut that opens the Control Center flyout.
 *
 * `mod+shift+l`, declared in the shortcut registry so the reference panel lists
 * it (not `mod+shift+p` — Firefox reserves that for its private window). Mirrors
 * the other global-shortcut hooks (a single `document` keydown listener that
 * toggles a store flag); mount once in the app shell beside them.
 */
export function useControlCenterShortcut(): void {
  const toggleControlCenter = useAppStore((s) => s.toggleControlCenter);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        toggleControlCenter();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [toggleControlCenter]);
}
