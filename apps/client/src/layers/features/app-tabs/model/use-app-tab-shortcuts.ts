/**
 * Keyboard shortcuts for the window's tabs (DOR-540).
 *
 * The set every tabbed app ships, so nobody has to learn ours: `Cmd/Ctrl+T` for
 * a new tab, `Cmd/Ctrl+1-8` to jump to a tab, `Cmd/Ctrl+9` for the last one,
 * and `Cmd/Ctrl+Shift+[` / `]` to step left and right. Registered on `document`
 * like every other global shortcut in the app.
 *
 * **Desktop shell only** (DOR-568), because the tabs they drive are. In a
 * browser these keys belong to the browser's own tabs and we do not touch them:
 * nothing is registered, nothing is cancelled, `Cmd/Ctrl+T` opens a browser tab
 * exactly as it always did. Whether a given browser would have let us cancel
 * them is beside the point — they address someone else's tabs there.
 *
 * `Cmd/Ctrl+W` is deliberately absent here: in the browser it closes the
 * browser's tab and we must not fight that, and on desktop it belongs to the
 * shell's Window menu, which sends it back over IPC (`useElectronCloseTab`).
 *
 * @module features/app-tabs/model/use-app-tab-shortcuts
 */
import { useEffect } from 'react';
import { isDesktopShell } from '@/layers/shared/lib';
import { useAppTabActions } from './use-app-tab-actions';

/** Digits that address a tab. 1-8 index from the left; 9 is always the last. */
const LAST_TAB_DIGIT = 9;

/** Register the tab shortcuts for as long as the shell is mounted. */
export function useAppTabShortcuts(): void {
  const actions = useAppTabActions();

  useEffect(() => {
    if (!isDesktopShell()) return;

    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

      if (event.shiftKey) {
        // Matched on `code`, not `key`: with Shift held these produce `{` and
        // `}`, and on a non-US layout something else again.
        if (event.code === 'BracketLeft') {
          event.preventDefault();
          actions.activateRelative(-1);
        } else if (event.code === 'BracketRight') {
          event.preventDefault();
          actions.activateRelative(1);
        }
        return;
      }

      if (event.key === 't' || event.key === 'T') {
        event.preventDefault();
        actions.create();
        return;
      }

      if (!event.code.startsWith('Digit')) return;
      const digit = Number(event.code.slice('Digit'.length));
      if (!Number.isInteger(digit) || digit < 1 || digit > LAST_TAB_DIGIT) return;
      event.preventDefault();
      if (digit === LAST_TAB_DIGIT) actions.activateLast();
      else actions.activateIndex(digit - 1);
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [actions]);
}
