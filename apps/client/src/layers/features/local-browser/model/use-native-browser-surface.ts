import { useEffect, type RefObject } from 'react';

/** Native guests sit above HTML: hide them before any app dialog or menu can be covered. */
export function useNativeBrowserSurface(
  ref: RefObject<HTMLDivElement | null>,
  connectionId: string | null,
  visible: boolean,
  onUnavailable: () => void
) {
  useEffect(() => {
    const bridge = window.electronAPI?.localBrowser;
    if (!bridge || !connectionId || !visible) return;
    let disposed = false;
    let broken = false;
    let previous = '';
    let frame = 0;
    let covered = false;
    const clipping: HTMLElement[] = [];
    for (let parent = ref.current?.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (/(hidden|clip|auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) {
        clipping.push(parent);
      }
    }
    const checkOverlays = () => {
      covered = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="dialog"][aria-modal="true"], [role="alertdialog"], [role="menu"], [data-radix-popper-content-wrapper]'
        ),
      ].some(
        (element) =>
          !element.contains(ref.current) && element.getClientRects().length > 0 && !element.hidden
      );
      publish();
    };
    const publish = () => {
      if (disposed || broken) return;
      const rect = ref.current?.getBoundingClientRect();
      let x = rect?.x ?? 0;
      let y = rect?.y ?? 0;
      let right = x + (rect?.width ?? 0);
      let bottom = y + (rect?.height ?? 0);
      // A native child does not inherit CSS clipping from the panel or scroll containers.
      for (const parent of clipping) {
        const area = parent.getBoundingClientRect();
        x = Math.max(x, area.x);
        y = Math.max(y, area.y);
        right = Math.min(right, area.x + area.width);
        bottom = Math.min(bottom, area.y + area.height);
      }
      const width = Math.max(0, right - x);
      const height = Math.max(0, bottom - y);
      const shown =
        !!rect && !covered && document.visibilityState !== 'hidden' && width > 0 && height > 0;
      const bounds = {
        connectionId,
        x,
        y,
        width,
        height,
        visible: shown,
      };
      const key = JSON.stringify(bounds);
      if (key !== previous) {
        previous = key;
        void bridge.setBounds(bounds).catch(() => {
          if (!disposed) {
            broken = true;
            onUnavailable();
          }
        });
      }
    };
    const tick = () => {
      publish();
      // Panel drag and entrance animations change position without a resize event.
      if (!disposed && !broken) frame = requestAnimationFrame(tick);
    };
    const observer = new MutationObserver(checkOverlays);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state', 'hidden', 'aria-modal', 'style', 'class'],
    });
    checkOverlays();
    tick();
    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      void bridge
        .setBounds({ connectionId, x: 0, y: 0, width: 0, height: 0, visible: false })
        .catch(() => {
          /* The host may already be closed. */
        });
    };
  }, [ref, connectionId, visible, onUnavailable]);
}
