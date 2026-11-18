/**
 * The Agent browser's panel and native-page keyboard shortcuts (DOR-4432, spec §13).
 *
 * In the panel's own chrome every key works: ⌘L, ⌘R / F5, ⌘[ ⌘] (Alt+← → off a Mac),
 * Esc and ⌘⇧C. Panel keys are handled before app-tab history, and a key no action took
 * is left for it. From inside the native page the shell forwards only ⌘L, ⌘R / F5 and
 * ⌘⇧C; Back, Forward and Esc stay the page's own, as in Chrome.
 *
 * @module features/local-browser/model/use-browser-keys
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { isMac } from '@/layers/shared/lib';

/** One browser action recognized from a keyboard shortcut. */
export type BrowserShortcut = DesktopBrowserShortcut | 'back' | 'forward' | 'stop';

/**
 * The current page and the actions its keys drive. Each action answers whether it
 * acted, so a key with nothing to do (Back with no page behind) is left to the app.
 */
export interface BrowserKeyActions {
  connectionId: string | null;
  loading: boolean;
  onFocusAddress: () => boolean;
  onReload: () => boolean;
  onBack: () => boolean;
  onForward: () => boolean;
  onStop: () => boolean;
  onCopyAddress: () => boolean;
}

/** Whether keys typed at `target` belong to a text field. */
function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select')) return true;
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/** Read one panel key as a browser action, or leave it alone. */
function browserShortcut(event: KeyboardEvent, loading: boolean): BrowserShortcut | null {
  const noModifiers = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  if (noModifiers) {
    if (event.code === 'F5') return 'reload';
    // In a text field Esc belongs to the field (the address field reverts on it).
    if (event.code === 'Escape' && loading && !isTextField(event.target)) return 'stop';
    return null;
  }

  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (modifier && !event.altKey) {
    if (event.shiftKey) return event.code === 'KeyC' ? 'copy-address' : null;
    if (event.code === 'KeyL') return 'focus-address';
    if (event.code === 'KeyR') return 'reload';
    if (event.code === 'BracketLeft') return 'back';
    if (event.code === 'BracketRight') return 'forward';
    return null;
  }

  if (
    !isMac &&
    event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !isTextField(event.target)
  ) {
    if (event.code === 'ArrowLeft') return 'back';
    if (event.code === 'ArrowRight') return 'forward';
  }
  return null;
}

/** Run one browser action against the latest page state, and answer whether it acted. */
function runShortcut(shortcut: BrowserShortcut, actions: BrowserKeyActions): boolean {
  if (shortcut === 'focus-address') return actions.onFocusAddress();
  if (shortcut === 'reload') return actions.onReload();
  if (shortcut === 'back') return actions.onBack();
  if (shortcut === 'forward') return actions.onForward();
  if (shortcut === 'copy-address') return actions.onCopyAddress();
  return actions.loading && actions.onStop();
}

/**
 * Handle browser keys in the panel and matching shortcuts forwarded from its native page.
 *
 * Returns the panel root's `onKeyDown`. A React handler, not a DOM listener: React runs
 * it after every handler inside the panel, so a key one of them used (`defaultPrevented`)
 * is left alone, and before `document`, where the app-tab history keys listen. A key
 * outside the panel never reaches it.
 *
 * @param actions - The current guest connection, load state, and browser actions.
 */
export function useBrowserKeys(actions: BrowserKeyActions): (event: ReactKeyboardEvent) => void {
  const latest = useRef(actions);
  useLayoutEffect(() => {
    latest.current = actions;
  });

  const onKeyDown = useCallback((event: ReactKeyboardEvent) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const shortcut = browserShortcut(event.nativeEvent, latest.current.loading);
    if (shortcut && runShortcut(shortcut, latest.current)) event.preventDefault();
  }, []);

  const connectionId = actions.connectionId;
  useEffect(() => {
    const subscribe = window.electronAPI?.localBrowser?.onShortcut;
    if (!connectionId || !subscribe) return;
    return subscribe((input) => {
      if (input.connectionId === connectionId) runShortcut(input.shortcut, latest.current);
    });
  }, [connectionId]);

  return onKeyDown;
}
