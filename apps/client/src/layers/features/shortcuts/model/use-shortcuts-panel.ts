import { useEffect } from 'react';
import { useAppStore } from '@/layers/shared/model';

/**
 * Register the `?` key handler that toggles the shortcuts reference panel.
 *
 * Guards against firing in text inputs (INPUT, TEXTAREA, contentEditable).
 * The `?` key is `Shift+/` — `e.key === '?'` captures it without checking shiftKey.
 */
export function useShortcutsPanel(): void {
  const toggleShortcutsPanel = useAppStore((s) => s.toggleShortcutsPanel);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if (e.key === '?' && !inInput) {
        e.preventDefault();
        toggleShortcutsPanel();
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [toggleShortcutsPanel]);
}
