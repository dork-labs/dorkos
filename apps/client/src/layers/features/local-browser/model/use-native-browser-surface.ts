import { useEffect, useRef, useState, type RefObject } from 'react';

/** Unchanged frames in a row before the surface stops following a move. */
const SETTLE_FRAMES = 6;
/** How long a covered page waits for its still before it hides without one. */
const STILL_WAIT_MS = 150;

/** A picture of the page, drawn where the page was while an app layer covers it. */
export interface NativeBrowserStill {
  /** An in-memory `blob:` address, revoked when the still is dropped. */
  url: string;
  /** Where the page was, in CSS pixels from the surface's top-left corner. */
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A still taken ahead of a layer, for a layer that must never blank the page:
 * the browser chrome's tooltips. `prepare` draws a still under the visible page
 * and answers whether one is in place; the layer opens only then, so the page
 * steps aside onto a picture that is already there. `release` drops a prepared
 * still that no layer came to cover.
 */
export interface NativeStillControls {
  prepare: () => Promise<boolean>;
  release: () => void;
}

/** Two frames: the first one paints what was just committed, the second follows it. */
const afterPaint = (run: () => void) =>
  requestAnimationFrame(() => {
    requestAnimationFrame(run);
  });

/**
 * App layers that float above the page's spot. Radix dialogs never set
 * `aria-modal`, so a modal is found by its backdrop, which covers the whole
 * window: an open dialog, sheet or drawer always overlaps (DOR-4418). A tooltip,
 * popover, menu or toast counts only where it overlaps the page (DOR-4417).
 */
const FLOATING_LAYERS = [
  '[data-slot="dialog-overlay"]',
  '[data-slot="alert-dialog-overlay"]',
  '[data-slot="sheet-overlay"]',
  '[data-slot="drawer-overlay"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-radix-popper-content-wrapper]',
  // Each toast on its own, so one in a far corner leaves the page alone (DOR-4438).
  '[data-sonner-toast]',
].join(', ');

/**
 * Native guests sit above HTML: hide them while any app layer overlaps their spot.
 * A covered page leaves a still of itself in its place (DOR-4438). The still stays in
 * this hook's memory only, never in a store, on disk, or on the way to the server, and
 * it is dropped when the page comes back, closes, or moves to another chat.
 */
export function useNativeBrowserSurface(
  ref: RefObject<HTMLDivElement | null>,
  connectionId: string | null,
  visible: boolean,
  onUnavailable: () => void,
  onStillControls?: (controls: NativeStillControls | null) => void
): NativeBrowserStill | null {
  const [still, setStill] = useState<NativeBrowserStill | null>(null);
  // Runs once the still is committed to the page, so the page steps aside only after.
  const onStillDrawn = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!still) return;
    const run = onStillDrawn.current;
    onStillDrawn.current = null;
    run?.();
  }, [still]);
  useEffect(() => {
    const bridge = window.electronAPI?.localBrowser;
    if (!bridge || !connectionId || !visible) return;
    let disposed = false;
    let broken = false;
    let previous = '';
    let frame = 0;
    // The page was last told to show itself, so it is on screen to capture.
    let live = false;
    // A capture is under way, so the page stays up until its still is drawn.
    let capturing = false;
    // Bumped to abandon a capture whose answer is no longer wanted.
    let ticket = 0;
    // This cover got no still in time, so the page hides without one until it is uncovered.
    let declined = false;
    let stillUrl: string | null = null;
    // The page was told to come back, and its still goes once that has painted.
    let returning = false;
    // A still was prepared ahead of a layer, so it stays while the page is up.
    let held = false;
    // Where the page was last shown, for a still taken ahead of a layer.
    let shownAt: { x: number; y: number; width: number; height: number } | null = null;
    const dropStill = () => {
      if (stillUrl) URL.revokeObjectURL(stillUrl);
      stillUrl = null;
      returning = false;
      held = false;
      setStill(null);
    };
    const capture = (x: number, y: number, width: number, height: number) => {
      const captureStill = bridge.captureStill;
      const rect = ref.current?.getBoundingClientRect();
      if (!captureStill || !rect) return false;
      const mine = ++ticket;
      capturing = true;
      const release = () => {
        if (mine !== ticket) return;
        capturing = false;
        schedule();
      };
      const decline = () => {
        if (mine !== ticket) return;
        declined = true;
        ticket += 1;
        capturing = false;
        schedule();
      };
      // Late or missing: the page hides as it did before, and a late still is dropped.
      const timeout = setTimeout(decline, STILL_WAIT_MS);
      void (async () => {
        let url: string | null = null;
        try {
          const bytes = await captureStill(connectionId);
          if (mine !== ticket || disposed || !bytes) return;
          url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
          const image = new Image();
          image.src = url;
          await image.decode?.();
          if (mine !== ticket || disposed) return;
          clearTimeout(timeout);
          if (stillUrl) URL.revokeObjectURL(stillUrl);
          stillUrl = url;
          url = null;
          // Draw the still first; the page steps aside a frame later, so nothing flashes.
          onStillDrawn.current = () => requestAnimationFrame(release);
          setStill({ url: stillUrl, left: x - rect.x, top: y - rect.y, width, height });
        } catch {
          /* No still: the page hides as it did before. */
        } finally {
          if (url) URL.revokeObjectURL(url);
          if (mine === ticket && capturing && !stillUrl) {
            clearTimeout(timeout);
            decline();
          }
        }
      })();
      return true;
    };
    // Its own count, so a prepared still never abandons a cover's capture, or the reverse.
    let preparing = 0;
    const prepare = async (): Promise<boolean> => {
      if (disposed || broken) return false;
      // Already in place (a cover's, or the last tooltip's while moving along the row).
      if (stillUrl) {
        held = true;
        return true;
      }
      const captureStill = bridge.captureStill;
      const rect = ref.current?.getBoundingClientRect();
      const at = shownAt;
      // A cover's capture is under way, or the page is not up to capture: no still to offer.
      if (capturing || !live || !captureStill || !rect || !at) return false;
      const mine = ++preparing;
      held = true;
      let url: string | null = null;
      const timedOut = () =>
        new Promise<null>((done) => setTimeout(() => done(null), STILL_WAIT_MS));
      try {
        const bytes = await Promise.race([captureStill(connectionId), timedOut()]);
        if (mine !== preparing || disposed || !held || !bytes || stillUrl)
          return !!stillUrl && held;
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
        const image = new Image();
        image.src = url;
        await image.decode?.();
        if (mine !== preparing || disposed || !held || stillUrl) return !!stillUrl && held;
        stillUrl = url;
        url = null;
        // Answer only once the still is drawn, so the layer opens onto it.
        const drawn = await Promise.race([
          new Promise<true>((done) => {
            onStillDrawn.current = () => requestAnimationFrame(() => done(true));
            setStill({
              url: stillUrl!,
              left: at.x - rect.x,
              top: at.y - rect.y,
              width: at.width,
              height: at.height,
            });
          }),
          timedOut(),
        ]);
        return drawn === true && mine === preparing && !disposed && held && stillUrl !== null;
      } catch {
        return false;
      } finally {
        if (url) URL.revokeObjectURL(url);
        if (mine === preparing && held && !stillUrl) held = false;
      }
    };
    const release = () => {
      preparing += 1;
      if (!held) return;
      held = false;
      if (live && stillUrl && !returning) dropStill();
      schedule();
    };
    onStillControls?.({ prepare, release });
    const clipping: HTMLElement[] = [];
    for (let parent = ref.current?.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (/(hidden|clip|auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) {
        clipping.push(parent);
      }
    }
    // A native page cannot be drawn under HTML, so it steps aside while a layer overlaps it.
    const overlapped = (x: number, y: number, right: number, bottom: number) => {
      // Below desktop width the panel is itself a sheet. Layers portal into the
      // page in the order they open, so its own backdrop, and anything opened
      // before it, sit under the page; a dialog opened over it comes later.
      const own = ref.current?.parentElement?.closest(FLOATING_LAYERS);
      return [...document.querySelectorAll<HTMLElement>(FLOATING_LAYERS)].some((element) => {
        if (element.hidden || element.contains(ref.current)) return false;
        if (own && element.compareDocumentPosition(own) & Node.DOCUMENT_POSITION_FOLLOWING)
          return false;
        const area = element.getBoundingClientRect();
        return (
          area.width > 0 &&
          area.height > 0 &&
          area.x < right &&
          area.x + area.width > x &&
          area.y < bottom &&
          area.y + area.height > y
        );
      });
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
      const onScreen = !!rect && document.visibilityState !== 'hidden' && width > 0 && height > 0;
      const covered = onScreen && overlapped(x, y, right, bottom);
      const shown = onScreen && !covered;
      if (!covered) {
        // Uncovered: abandon a capture in flight, and drop the still once the page is back.
        if (capturing) ticket += 1;
        capturing = false;
        declined = false;
      }
      // Covered while live: the page stays up until its still is in place.
      if (
        covered &&
        live &&
        (capturing || (!stillUrl && !declined && capture(x, y, width, height)))
      )
        return;
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
        live = shown;
        shownAt = shown ? { x, y, width, height } : shownAt;
        const sent = bridge.setBounds(bounds);
        if (shown && stillUrl) {
          // The page is back on top; the still goes a frame later, so nothing flashes.
          const back = stillUrl;
          returning = true;
          void sent.then(() =>
            afterPaint(() => {
              if (!disposed && stillUrl === back && live) dropStill();
            })
          );
        }
        void sent.catch(() => {
          if (!disposed) {
            broken = true;
            onUnavailable();
          }
        });
      } else if (shown && stillUrl && !returning && !held) {
        // Already back (a capture was abandoned before the page hid).
        dropStill();
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
      publish();
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
    publish();
    lastFrameKey = previous;
    // Follow the panel's own entrance, then settle.
    schedule();
    return () => {
      disposed = true;
      ticket += 1;
      onStillControls?.(null);
      onStillDrawn.current = null;
      // Closing, or moving to another chat, drops the still with the page.
      dropStill();
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
  }, [ref, connectionId, visible, onUnavailable, onStillControls]);
  return still;
}
