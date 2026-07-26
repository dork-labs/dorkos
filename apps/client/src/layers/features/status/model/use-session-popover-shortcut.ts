/**
 * Keyboard access to the Session panel.
 *
 * @module features/status/model/use-session-popover-shortcut
 */
import { useEffect, useRef } from 'react';

/**
 * Register the `Cmd+Shift+.` / `Ctrl+Shift+.` handler that opens and closes the
 * Session panel. Follows the same document-level pattern as the right-panel and
 * agent-profile shortcuts.
 *
 * The callback is held in a ref, so callers do not have to memoize it and the
 * listener is attached exactly once.
 *
 * @param toggle - Called when the combo fires.
 */
export function useSessionPopoverShortcut(toggle: () => void): void {
  const toggleRef = useRef(toggle);
  useEffect(() => {
    toggleRef.current = toggle;
  }, [toggle]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Shift turns `.` into `>` on a US layout, so accept both rather than
      // silently working on only half the keyboards.
      const isPeriod = e.key === '.' || e.key === '>';
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && isPeriod) {
        e.preventDefault();
        toggleRef.current();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
}
