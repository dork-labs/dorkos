import { useRef, useState } from 'react';

/**
 * Compute the next roving-focus index for a grid keyboard event.
 *
 * Pure movement core behind {@link useRovingFocus}: arrows move by one
 * (left/right) or by a column stride (up/down), Home/End jump to the edges,
 * and every result clamps into `[0, count)`. Returns `null` for keys the
 * roving pattern does not handle so callers can let them through.
 *
 * @param key - The `KeyboardEvent.key` value.
 * @param index - The currently focused item index.
 * @param columns - Items per visual row (the up/down stride).
 * @param count - Total item count.
 * @returns The next index, or `null` when the key is not a roving key.
 */
export function nextRovingIndex(
  key: string,
  index: number,
  columns: number,
  count: number
): number | null {
  let next: number;
  switch (key) {
    case 'ArrowRight':
      next = index + 1;
      break;
    case 'ArrowLeft':
      next = index - 1;
      break;
    case 'ArrowDown':
      next = index + columns;
      break;
    case 'ArrowUp':
      next = index - columns;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = count - 1;
      break;
    default:
      return null;
  }
  return Math.max(0, Math.min(count - 1, next));
}

/**
 * Roving-tabindex focus management for a grid of interactive elements.
 *
 * One element holds `tabIndex=0` (the rest -1) so the grid is a single tab
 * stop; arrow keys move focus between elements, with the column stride
 * measured live from element offsets so the same markup works across
 * responsive breakpoints.
 *
 * @param count - Total number of focusable elements in the grid.
 */
export function useRovingFocus(count: number) {
  const [focusIndex, setFocusIndex] = useState(0);
  const refs = useRef<(HTMLElement | null)[]>([]);

  /** Count elements sharing the first element's top offset — the live column count. */
  function columnCount(): number {
    const els = refs.current.slice(0, count).filter(Boolean) as HTMLElement[];
    if (els.length === 0) return 1;
    const firstTop = els[0].offsetTop;
    return Math.max(1, els.filter((el) => el.offsetTop === firstTop).length);
  }

  function moveFocus(next: number) {
    const clamped = Math.max(0, Math.min(count - 1, next));
    setFocusIndex(clamped);
    refs.current[clamped]?.focus();
  }

  /** Ref callback for the element at `index`. */
  function setRef(index: number) {
    return (el: HTMLElement | null) => {
      refs.current[index] = el;
    };
  }

  /** `tabIndex` for the element at `index` (0 for the roving stop, else -1). */
  function tabIndexFor(index: number): number {
    return focusIndex === index ? 0 : -1;
  }

  /** KeyDown handler for the element at `index`. */
  function handleKeyDown(event: React.KeyboardEvent, index: number) {
    const next = nextRovingIndex(event.key, index, columnCount(), count);
    if (next === null) return;
    event.preventDefault();
    moveFocus(next);
  }

  return { focusIndex, setRef, tabIndexFor, handleKeyDown, moveFocus };
}
