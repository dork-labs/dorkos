/**
 * Back and Forward keys and mouse buttons for the active tab (DOR-2107).
 *
 * The keys every browser already taught people: `Cmd+[` / `Cmd+]` on a Mac,
 * `Ctrl+[` / `Ctrl+]` and `Alt+←` / `Alt+→` elsewhere, and the mouse's side
 * buttons everywhere. Electron maps none of them for a frameless window, so
 * without this the desktop app has no Back key at all.
 *
 * **Desktop shell only**, like the tabs they drive. In a browser the page's
 * own history is the browser's to walk, and these keys already do that there.
 *
 * Three choices that keep it out of the way:
 *
 * - **An editor that used the key keeps it.** Bubble phase on `document`, and
 *   an event something already handled (`defaultPrevented`) is left alone —
 *   CodeMirror binds `Mod-[` to outdent, and outdenting must not also go back.
 * - **`Alt+Arrow` never fires from a text field**, where some Linux setups use
 *   it to move by word. The bracket chords do, as in a browser: a plain text
 *   field does nothing with them.
 * - **Not `Option+Arrow` on a Mac**, which moves by word in every text field.
 *
 * @module features/app-tabs/model/use-tab-history-shortcuts
 */
import { useEffect } from 'react';
import { useRouter } from '@tanstack/react-router';
import { isDesktopShell, isMac } from '@/layers/shared/lib';
import { goBack, goForward } from './tab-history';

/** `MouseEvent.button` for the side buttons: 3 is Back, 4 is Forward. */
const MOUSE_BACK = 3;
const MOUSE_FORWARD = 4;

/** Whether keys typed at `target` belong to a text field. */
function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select')) return true;
  // `isContentEditable` is the real answer but jsdom does not implement it; the
  // attribute check is what it resolves to for every editor we ship.
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/**
 * Which way a key press asks to go, or `null` when it is not ours.
 *
 * @param event - The keydown to read.
 */
function keyDirection(event: KeyboardEvent): 'back' | 'forward' | null {
  if (event.shiftKey) return null;

  // Matched on `code`, not `key`: layout-independent, like the tab chords.
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (mod && !event.altKey) {
    if (event.code === 'BracketLeft') return 'back';
    if (event.code === 'BracketRight') return 'forward';
    return null;
  }

  if (!isMac && event.altKey && !event.ctrlKey && !event.metaKey) {
    if (isTextField(event.target)) return null;
    if (event.key === 'ArrowLeft') return 'back';
    if (event.key === 'ArrowRight') return 'forward';
  }
  return null;
}

/** Register the Back/Forward keys and mouse buttons. Mounted once, by the shell. */
export function useTabHistoryShortcuts(): void {
  const router = useRouter();

  useEffect(() => {
    if (!isDesktopShell()) return;

    const go = (direction: 'back' | 'forward') =>
      direction === 'back' ? goBack(router) : goForward(router);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const direction = keyDirection(event);
      if (!direction) return;
      event.preventDefault();
      // Key repeat is allowed: holding the key to walk back is browser habit.
      go(direction);
    };

    const isSideButton = (event: MouseEvent) =>
      event.button === MOUSE_BACK || event.button === MOUSE_FORWARD;

    // Swallowed on press as well as release, so nothing else reacts to half of
    // a click this hook is about to act on.
    const onMouseDown = (event: MouseEvent) => {
      if (isSideButton(event)) event.preventDefault();
    };

    const onMouseUp = (event: MouseEvent) => {
      if (!isSideButton(event)) return;
      event.preventDefault();
      go(event.button === MOUSE_BACK ? 'back' : 'forward');
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [router]);
}
