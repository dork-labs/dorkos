/**
 * One Tab stop per sidebar section.
 *
 * A 60-agent Library is 60 focusable rows, and `Tab` through it is 60 presses
 * before the footer. The WAI-ARIA answer is a roving tabindex: the section
 * holds exactly one Tab stop — the row you are on if it is in this section,
 * otherwise the first — and the arrow keys move within it. Sixty rows become
 * one stop; four sections become four (R2, spec §C).
 *
 * **Managed through the DOM rather than through per-row props.** The sidebar's
 * rows are rendered by half a dozen section components and a shared
 * `renderItem` callback, and threading a `tabIndex` down every one of those
 * paths would put the a11y contract in six places that can each forget it. A
 * section wraps its list, this hook finds the rows inside it by their
 * `data-sidebar-row` mark, and no row has to know it is in a roving list.
 *
 * @module shared/model/use-roving-focus
 */
import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';

/** The mark {@link useRovingFocus} finds its rows by — stamped by `SidebarRow`. */
export const SIDEBAR_ROW_ATTRIBUTE = 'data-sidebar-row';

/** The mark a section header carries, so `ArrowLeft`/`ArrowRight` can reach its toggle. */
export const SIDEBAR_SECTION_TOGGLE_ATTRIBUTE = 'data-sidebar-section-toggle';

/** Props to spread onto the element wrapping one section's rows. */
export interface RovingFocusProps {
  /** Registers the container. */
  ref: (element: HTMLElement | null) => void;
  /** Arrow / Home / End traversal within the section. */
  onKeyDown: (event: KeyboardEvent) => void;
}

/** Every row in the container, in DOM order. */
function rowsIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[${SIDEBAR_ROW_ATTRIBUTE}]`));
}

/**
 * Which row holds the section's single Tab stop: the one the reader is on
 * (`aria-current="page"`), else the first.
 */
function rovingIndex(rows: HTMLElement[]): number {
  const current = rows.findIndex((row) => row.getAttribute('aria-current') === 'page');
  return current === -1 ? 0 : current;
}

/**
 * Give a section's row list exactly one Tab stop, with arrow traversal inside it.
 *
 * `ArrowDown` / `ArrowUp` move between rows (no wrapping — the ends are the
 * ends, and `Tab` is how you leave), `Home` / `End` jump to them. A section
 * header inside the container answers `ArrowLeft` / `ArrowRight` by collapsing
 * or expanding, which is the Tree pattern's own contract and the reason a
 * keyboard reader never has to hunt for a chevron.
 *
 * Spread the returned props onto the element that contains the section's rows.
 *
 * @param options - `onCollapse` / `onExpand` wire the header's left/right arrows;
 *   omit them for a section that cannot collapse.
 */
export function useRovingFocus(options?: {
  /** Fold the section — `ArrowLeft` on its header. */
  onCollapse?: () => void;
  /** Unfold it — `ArrowRight` on its header. */
  onExpand?: () => void;
}): RovingFocusProps {
  const containerRef = useRef<HTMLElement | null>(null);
  // Kept in a ref so the returned props stay referentially stable across the
  // renders these callbacks are re-created on — a section re-renders on every
  // unread change, and a new `onKeyDown` identity each time would defeat any
  // memoized child it is spread onto.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  /** Re-stamp `tabIndex` so exactly one row in the container is reachable by Tab. */
  const sync = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const rows = rowsIn(container);
    if (rows.length === 0) return;
    const roving = rovingIndex(rows);
    rows.forEach((row, index) => {
      row.tabIndex = index === roving ? 0 : -1;
    });
  }, []);

  // After every commit: rows arrive from queries, leave on filter changes, and
  // the active one moves as the reader navigates. Cheap — a handful of nodes,
  // and only inside this one container.
  useEffect(sync);

  const ref = useCallback(
    (element: HTMLElement | null) => {
      containerRef.current = element;
      sync();
    },
    [sync]
  );

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;

    // A header's own two keys first: they are about the SECTION, not about
    // moving within it, and a header is not one of the rows below.
    if (target.closest(`[${SIDEBAR_SECTION_TOGGLE_ATTRIBUTE}]`)) {
      if (event.key === 'ArrowLeft' && optionsRef.current?.onCollapse) {
        event.preventDefault();
        optionsRef.current.onCollapse();
      } else if (event.key === 'ArrowRight' && optionsRef.current?.onExpand) {
        event.preventDefault();
        optionsRef.current.onExpand();
      }
      return;
    }

    const rows = rowsIn(container);
    if (rows.length === 0) return;
    const row = target.closest<HTMLElement>(`[${SIDEBAR_ROW_ATTRIBUTE}]`);
    const index = row ? rows.indexOf(row) : -1;
    if (index === -1) return;

    // No wrapping. The first and last rows are the ends of the section, and a
    // reader who arrows past one should be told by nothing happening rather
    // than be teleported to the other end of a list they cannot see all of.
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(index + 1, rows.length - 1);
        break;
      case 'ArrowUp':
        next = Math.max(index - 1, 0);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = rows.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const target_ = rows[next];
    if (!target_) return;
    // Move the stop with the focus, so Tab returns to where the reader left off
    // rather than to the top of the section.
    rows.forEach((r, i) => {
      r.tabIndex = i === next ? 0 : -1;
    });
    target_.focus();
  }, []);

  return { ref, onKeyDown };
}
