import { useEffect, type RefObject } from 'react';

/** Unchanged frames in a row before the surface stops following a move. */
const SETTLE_FRAMES = 6;

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
    // Event-driven, not a per-frame loop (DOR-3312): measuring every frame kept
    // the window busy for as long as the panel stayed open, even on a still
    // screen. Anything that can move the surface schedules one frame; a frame
    // that moved, or a finite animation still running anywhere (CSS, or Motion's
    // eventless WAAPI runs), keeps it going, and a few still frames in a row end
    // it: a slow or delayed start must not stop the follow early. Endless loops
    // such as spinners are ignored, or they would keep it running forever.
    let lastFrameKey = '';
    let stillFrames = 0;
    const animating = () =>
      document
        .getAnimations?.()
        .some(
          (animation) =>
            animation.playState === 'running' &&
            animation.effect?.getTiming().iterations !== Infinity
        ) ?? false;
    const onFrame = () => {
      frame = 0;
      checkOverlays();
      if (disposed || broken) return;
      stillFrames = previous === lastFrameKey ? stillFrames + 1 : 0;
      lastFrameKey = previous;
      if (stillFrames < SETTLE_FRAMES || animating()) requestFrame();
    };
    const requestFrame = () => {
      if (!disposed && !broken && !frame) frame = requestAnimationFrame(onFrame);
    };
    // Every outside trigger starts a fresh settle count.
    const schedule = () => {
      stillFrames = 0;
      requestFrame();
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state', 'hidden', 'aria-modal', 'style', 'class'],
    });
    const resizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (ref.current) resizes?.observe(ref.current);
    for (const parent of clipping) resizes?.observe(parent);
    const captured = [
      'scroll',
      'transitionrun',
      'transitionstart',
      'transitionend',
      'transitioncancel',
      'animationstart',
      'animationend',
      'animationcancel',
    ];
    for (const type of captured) {
      document.addEventListener(type, schedule, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('resize', schedule);
    checkOverlays();
    lastFrameKey = previous;
    // Follow the panel's own entrance, then settle.
    schedule();
    return () => {
      disposed = true;
      observer.disconnect();
      resizes?.disconnect();
      for (const type of captured) document.removeEventListener(type, schedule, true);
      document.removeEventListener('visibilitychange', schedule);
      window.removeEventListener('resize', schedule);
      cancelAnimationFrame(frame);
      void bridge
        .setBounds({ connectionId, x: 0, y: 0, width: 0, height: 0, visible: false })
        .catch(() => {
          /* The host may already be closed. */
        });
    };
  }, [ref, connectionId, visible, onUnavailable]);
}
