/**
 * Move focus to a screen's heading when the screen arrives.
 *
 * @module features/onboarding/model/use-focus-on-arrival
 */
import { useEffect, useRef } from 'react';

/**
 * Focus the element this ref is put on, once, when it mounts.
 *
 * Each first-run screen replaces the last in place, so without this a
 * keyboard or screen-reader user is left on a control that no longer exists
 * and hears nothing about the new screen. The heading takes the focus
 * (`tabIndex={-1}`, so it is not a tab stop of its own) and is read out.
 *
 * @returns A ref for the heading.
 */
export function useFocusOnArrival<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return ref;
}
