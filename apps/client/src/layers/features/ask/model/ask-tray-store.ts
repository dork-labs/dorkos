/**
 * "Show me the next thing waiting on me" — the one request the shortcut makes,
 * and the tray answers.
 *
 * A store rather than a call, because the two are in different layers: the
 * shortcut is a feature hook and the tray it has to open is a widget's popover.
 * The widget subscribes and does the opening, which keeps `features/ask` from
 * knowing that a header pill exists.
 *
 * @module features/ask/model/ask-tray-store
 */
import { create } from 'zustand';

/** The standing request to show the tray. */
interface AskTrayState {
  /**
   * Bumped every time somebody asks to be taken to the next Ask.
   *
   * A counter rather than a boolean: two presses in a row are two requests, and
   * a boolean would swallow the second.
   */
  openRequest: number;
}

const useAskTrayStore = create<AskTrayState>(() => ({ openRequest: 0 }));

/** Ask the tray to open and put focus on the first card waiting in it. */
export function requestAskTray(): void {
  useAskTrayStore.setState((state) => ({ openRequest: state.openRequest + 1 }));
}

/**
 * The current request count — subscribe to it to open the tray when it changes.
 *
 * @returns A number that increases each time {@link requestAskTray} is called.
 */
export function useAskTrayRequest(): number {
  return useAskTrayStore((state) => state.openRequest);
}
