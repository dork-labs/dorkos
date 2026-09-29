/**
 * Keep keyboard focus from falling to the page when a control disappears.
 *
 * An Update button leaves once there is nothing left to install. If it had
 * focus, the browser drops focus to `<body>` and a keyboard or screen-reader
 * user loses their place. This moves focus to a nearby target instead (the
 * line that now says where things stand), and only when focus really was lost:
 * if the person has moved on to something else, it stays where they put it.
 *
 * @module features/marketplace/model/use-focus-rescue
 */
import { useEffect, useMemo, useRef, type FocusEvent } from 'react';

/** What {@link useFocusRescue} returns. */
export interface FocusRescue<T extends HTMLElement> {
  /** Attach to the element that takes focus; give it `tabIndex={-1}`. */
  targetRef: React.RefObject<T | null>;
  /** Spread onto the control that may disappear. */
  controlProps: {
    onFocus: () => void;
    onBlur: (event: FocusEvent) => void;
  };
}

/**
 * Move focus to `targetRef` when the control stops being `present` while it
 * held focus.
 *
 * @param present - Whether the control is rendered.
 */
export function useFocusRescue<T extends HTMLElement>(present: boolean): FocusRescue<T> {
  const targetRef = useRef<T | null>(null);
  const hadFocus = useRef(false);

  useEffect(() => {
    if (present || !hadFocus.current) return;
    hadFocus.current = false;
    const active = document.activeElement;
    // Only when focus fell to nothing: never take it from where the person moved it.
    if (active === null || active === document.body) targetRef.current?.focus();
  }, [present]);

  // Built once: the handlers only touch the ref when the events fire.
  const controlProps = useMemo<FocusRescue<T>['controlProps']>(
    () => ({
      onFocus: () => {
        hadFocus.current = true;
      },
      // A removed element may or may not fire blur, depending on the browser;
      // a blur to another element is the person moving on.
      onBlur: (event) => {
        if (event.relatedTarget !== null) hadFocus.current = false;
      },
    }),
    []
  );

  return { targetRef, controlProps };
}
