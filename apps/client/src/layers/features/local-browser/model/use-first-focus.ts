import { useEffect, type RefObject } from 'react';

/**
 * Focus a view's one main action when it shows (DOR-4265), unless the person is
 * already in another control or another window: a chat box keeps its focus, and so
 * does a page the person moved to outside the app.
 *
 * @param target - The action to focus.
 * @param ready - Whether the view is on screen and the action can be used.
 */
export function useFirstFocus(target: RefObject<HTMLElement | null>, ready: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!ready || !element) return;
    const active = document.activeElement;
    const panel = element.closest('[data-slot="local-browser-panel"]');
    if (!document.hasFocus()) return;
    if (!active || active === document.body || panel?.contains(active)) element.focus();
  }, [target, ready]);
}
