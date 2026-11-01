/**
 * How the docked sidebar leaves and comes back: its spring, and where focus goes.
 *
 * **A sidebar off the screen is not merely out of sight.** It was still in the tab
 * order, so after ⌘B the next nine Tabs landed on controls nobody could see, and
 * focus itself could stay on one. This keeps the panel out of reach while it is
 * shut, and moves focus only when shutting it would otherwise lose focus.
 *
 * @module shared/ui/sidebar-collapse
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { Transition } from 'motion/react';
import { SPRING } from '@/layers/shared/lib/motion';

/**
 * How the panel moves for this reader: a spring, so ⌘B pressed mid-flight
 * retargets from where the panel is, and instant under reduced motion.
 *
 * @param reducedMotion - What `useReducedMotion()` answered. `null` means not
 *   asked yet, which is not a preference.
 */
export function sidebarFoldTransition(reducedMotion: boolean | null): Transition {
  if (reducedMotion === true) return { duration: 0 };
  // The spring a section folds on: about 180 ms, no overshoot.
  return SPRING.fold;
}

/** Where focus was when the panel shut, and the section to fall back on. */
interface RememberedFocus {
  element: HTMLElement;
  section: Element | null;
}

/**
 * Where focus goes when the panel reopens: the control it left, else the Tab stop
 * of the section that control was in, else the trigger.
 */
function reopenTarget(remembered: RememberedFocus, trigger: HTMLElement | null) {
  if (remembered.element.isConnected) return remembered.element;
  const stop = remembered.section?.isConnected
    ? remembered.section.querySelector<HTMLElement>('[tabindex="0"]')
    : null;
  return stop ?? trigger;
}

/**
 * Keeps a shut panel out of the tab order and moves focus across the change.
 *
 * Shutting moves focus to the trigger only when focus was in the panel, so a
 * person typing in the composer can press ⌘B twice without losing their place.
 * Reopening hands it back only if focus is still where shutting left it: an agent
 * opening the panel, or a person who has since moved on, keeps what they have.
 *
 * `inert` is set by hand, after focus has moved, because React would set it during
 * commit and the browser may blur the focused control before an effect can read it.
 *
 * @param open - Whether the panel is open.
 * @param panelRef - The panel, which takes `inert` while it is shut.
 * @param triggerRef - The control that stays on screen to open it again.
 */
export function useSidebarCollapseFocus(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>
): void {
  const wasOpen = useRef(open);
  const remembered = useRef<RememberedFocus | null>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const changed = wasOpen.current !== open;
    wasOpen.current = open;
    const trigger = triggerRef.current;

    if (!open) {
      const active = document.activeElement;
      if (changed && active instanceof HTMLElement && panel.contains(active)) {
        remembered.current = {
          element: active,
          section: active.closest('[data-sidebar="group"]'),
        };
        trigger?.focus({ preventScroll: true });
      }
      panel.setAttribute('inert', '');
      return;
    }

    panel.removeAttribute('inert');
    if (!changed) return;
    const memo = remembered.current;
    remembered.current = null;
    if (memo === null) return;
    const active = document.activeElement;
    if (active !== trigger && active !== document.body && active !== null) return;
    reopenTarget(memo, trigger)?.focus({ preventScroll: true });
  }, [open, panelRef, triggerRef]);
}
