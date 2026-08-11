/**
 * One Tab stop per sidebar section.
 *
 * A 60-agent Library is 60 focusable rows, and `Tab` through it is 60 presses
 * before the footer. The WAI-ARIA answer is a roving tabindex: the section
 * holds exactly one Tab stop and the arrow keys move within it. Sixty rows
 * become one stop; four sections become four (R2, spec §C).
 *
 * **The section is ONE composite widget, header included.** The header, its
 * rows, and every row's "⋮" are all focusable, so anything left out of the
 * roving set stays in the tab order and quietly re-adds a stop per row — which
 * is exactly how the first version of this hook shipped a 60-agent Library at
 * 61 stops rather than 1. The set is therefore "every focusable in the
 * container", and the traversal is two-dimensional: `ArrowDown`/`ArrowUp` walk
 * the header and rows, and `ArrowLeft`/`ArrowRight` walk a row's own LANE — its
 * glyph control, the row, a control in its right gutter, its "⋮" — so every
 * control a pointer would reveal has a keyboard path to it.
 *
 * **Managed through the DOM rather than through per-row props.** The sidebar's
 * rows are rendered by half a dozen section components and a shared
 * `renderItem` callback, and threading a `tabIndex` down every one of those
 * paths would put the a11y contract in six places that can each forget it. A
 * section wraps its header and list, this hook finds the pieces inside it by
 * their marks, and no row has to know it is in a roving list.
 *
 * @module shared/model/use-roving-focus
 */
import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';

/** The mark {@link useRovingFocus} finds its rows by — stamped by `SidebarRow`. */
export const SIDEBAR_ROW_ATTRIBUTE = 'data-sidebar-row';

/** The mark a section header carries, so `ArrowLeft`/`ArrowRight` can reach its toggle. */
export const SIDEBAR_SECTION_TOGGLE_ATTRIBUTE = 'data-sidebar-section-toggle';

/** The mark a hover-revealed "⋮" carries — a satellite of its row, never a Tab stop of its own. */
export const SIDEBAR_ACTIONS_ATTRIBUTE = 'data-sidebar-actions';

/** The mark an interactive glyph carries — the other satellite, on the row's other side. */
export const SIDEBAR_GLYPH_ACTION_ATTRIBUTE = 'data-sidebar-glyph-action';

/** The mark a control in the row's right gutter carries, between the row and its "⋮". */
export const SIDEBAR_TRAILING_ACTION_ATTRIBUTE = 'data-sidebar-trailing-action';

/**
 * Everything in a section that a browser would otherwise put in the tab order.
 *
 * Deliberately broader than "rows": the guard this hook exists to provide is
 * "one stop per section", and any focusable it does not know about is a stop it
 * did not remove.
 */
const FOCUSABLE = [
  `[${SIDEBAR_SECTION_TOGGLE_ATTRIBUTE}]`,
  `[${SIDEBAR_ROW_ATTRIBUTE}]`,
  `[${SIDEBAR_ACTIONS_ATTRIBUTE}]`,
  `[${SIDEBAR_GLYPH_ACTION_ATTRIBUTE}]`,
  `[${SIDEBAR_TRAILING_ACTION_ATTRIBUTE}]`,
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[tabindex]',
].join(',');

/**
 * A stop's satellites, in the order they sit on screen, with `null` marking
 * where the stop itself falls between them.
 *
 * Left to right: the glyph control, the row, the trailing control, the "⋮".
 * Spelling the lane out as a list is what lets one `±1` step serve every
 * sideways move — the version before this hard-coded "ArrowRight means the ⋮",
 * which had no room for a third satellite and left any control in the right
 * gutter reachable by pointer only.
 */
const LANE = [
  SIDEBAR_GLYPH_ACTION_ATTRIBUTE,
  null,
  SIDEBAR_TRAILING_ACTION_ATTRIBUTE,
  SIDEBAR_ACTIONS_ATTRIBUTE,
] as const;

/** Anything in a lane that is not the stop at its centre. */
const SATELLITE_SELECTOR = LANE.filter((mark) => mark !== null)
  .map((mark) => `[${mark}]`)
  .join(',');

/** Props to spread onto the element wrapping one section's header and rows. */
export interface RovingFocusProps {
  /** Registers the container. */
  ref: (element: HTMLElement | null) => void;
  /** Arrow / Home / End traversal within the section. */
  onKeyDown: (event: KeyboardEvent) => void;
}

/** Everything focusable in the container, in DOM order. */
function focusablesIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/**
 * The section's own stops — the header and the rows.
 *
 * A "⋮" is not one: it is reached sideways from the row it belongs to, so that
 * a reader walking a list of sixty agents presses ArrowDown sixty times rather
 * than a hundred and twenty.
 */
function stopsIn(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      `[${SIDEBAR_SECTION_TOGGLE_ATTRIBUTE}],[${SIDEBAR_ROW_ATTRIBUTE}]`
    )
  );
}

/** One of a stop's satellites — its "⋮" on the right, its glyph control on the left. */
function satelliteFor(stop: HTMLElement, mark: string): HTMLElement | null {
  return (
    stop.parentElement?.querySelector<HTMLElement>(`[${mark}]`) ??
    stop.closest('[data-slot="sidebar-menu-item"]')?.querySelector<HTMLElement>(`[${mark}]`) ??
    null
  );
}

/**
 * A stop and its satellites as one left-to-right lane, skipping the ones this
 * particular row does not have.
 *
 * @param stop - The row or header the lane belongs to.
 */
function laneFor(stop: HTMLElement): HTMLElement[] {
  return LANE.map((mark) => (mark === null ? stop : satelliteFor(stop, mark))).filter(
    (element): element is HTMLElement => element !== null
  );
}

/** Which way a sideways key moves along a lane, or `0` for a key that does not. */
function laneStep(key: string): number {
  if (key === 'ArrowLeft') return -1;
  if (key === 'ArrowRight') return 1;
  return 0;
}

/**
 * Give a section's header and rows exactly one Tab stop, with arrow traversal
 * inside it.
 *
 * `ArrowDown` / `ArrowUp` move between the header and the rows (no wrapping —
 * the ends are the ends, and `Tab` is how you leave), `Home` / `End` jump to
 * them. `ArrowLeft` / `ArrowRight` on the header collapse or expand it, which
 * is the Tree pattern's own contract and the reason a keyboard reader never has
 * to hunt for a chevron; on a row they step onto and off its "⋮".
 *
 * Spread the returned props onto the element that contains the section's header
 * AND its list — the header's two keys are dead if it sits outside.
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

  /**
   * Where the reader left the section, so Tab comes back to it.
   *
   * **A remembered ELEMENT, not a remembered index.** An index would be reset
   * by anything that re-renders the section — an unread count ticking, a query
   * settling — and the reader would find themselves at the top of the list
   * again after every one. The element survives all of that, and is abandoned
   * only when it genuinely leaves the DOM.
   */
  const parkedRef = useRef<HTMLElement | null>(null);

  /** Re-stamp `tabIndex` so exactly one element in the container is reachable by Tab. */
  const sync = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const stops = stopsIn(container);
    if (stops.length === 0) return;

    // The parked element first, then the row the reader is actually on, then
    // the top. Falling back only when the parked one has left the DOM is what
    // makes the stop survive a re-render.
    const parked = parkedRef.current;
    const roving =
      parked && stops.includes(parked)
        ? parked
        : (stops.find((stop) => stop.getAttribute('aria-current') === 'page') ?? stops[0]);
    if (!roving) return;
    parkedRef.current = roving;

    // Every focusable, not just the stops: a "⋮" left un-stamped is a Tab stop
    // per row, which is the whole defect this hook exists to prevent.
    for (const element of focusablesIn(container)) {
      element.tabIndex = element === roving ? 0 : -1;
    }
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

  /**
   * Park the Tab stop on `park` and put focus on `next`.
   *
   * The two are the same element for a move within the list. They differ when
   * focus steps out along a row's lane: the stop stays on the ROW, because a
   * satellite is a visit — Tabbing away and back should return the reader to
   * the list rather than to a control they were only passing through.
   */
  const moveTo = useCallback(
    (park: HTMLElement, next: HTMLElement) => {
      parkedRef.current = park;
      sync();
      next.focus();
    },
    [sync]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const stops = stopsIn(container);
      if (stops.length === 0) return;

      /** Step one place along `owner`'s lane from `from`, if there is one to step to. */
      const stepAlongLane = (owner: HTMLElement, from: HTMLElement, step: number): boolean => {
        const lane = laneFor(owner);
        const next = lane[lane.indexOf(from) + step];
        if (next === undefined) return false;
        moveTo(owner, next);
        return true;
      };

      // ── Sideways: a row and its satellites ──
      // A satellite steps back towards its row, and past it to the control on
      // the far side — a reader who stepped out to one steps back in.
      const satellite = target.closest<HTMLElement>(SATELLITE_SELECTOR);
      if (satellite) {
        const step = laneStep(event.key);
        if (step === 0) return;
        const owner = stops.find((stop) => laneFor(stop).includes(satellite));
        if (!owner) return;
        if (stepAlongLane(owner, satellite, step)) event.preventDefault();
        return;
      }

      const stop = target.closest<HTMLElement>(
        `[${SIDEBAR_SECTION_TOGGLE_ATTRIBUTE}],[${SIDEBAR_ROW_ATTRIBUTE}]`
      );
      const index = stop ? stops.indexOf(stop) : -1;
      if (index === -1 || !stop) return;

      const isHeader = stop.hasAttribute(SIDEBAR_SECTION_TOGGLE_ATTRIBUTE);

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        // The header's two keys are about the SECTION rather than about moving
        // within it: they fold and unfold it.
        if (isHeader) {
          const fold = event.key === 'ArrowLeft' ? optionsRef.current?.onCollapse : undefined;
          const unfold = event.key === 'ArrowRight' ? optionsRef.current?.onExpand : undefined;
          const run = fold ?? unfold;
          if (!run) return;
          event.preventDefault();
          run();
          return;
        }
        // On a row, the arrows step onto its satellites — the keyboard path to
        // controls a pointer would reveal and a keyboard otherwise could not
        // reach: the glyph (a face that opens a profile) to the left, then the
        // trailing control and the "⋮" to the right.
        if (stepAlongLane(stop, stop, laneStep(event.key))) event.preventDefault();
        return;
      }

      // ── Up and down: the header and the rows ──
      // No wrapping. The first and last are the ends of the section, and a
      // reader who arrows past one should be told by nothing happening rather
      // than be teleported to the other end of a list they cannot see all of.
      let next: number | null = null;
      switch (event.key) {
        case 'ArrowDown':
          next = Math.min(index + 1, stops.length - 1);
          break;
        case 'ArrowUp':
          next = Math.max(index - 1, 0);
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = stops.length - 1;
          break;
        default:
          return;
      }

      event.preventDefault();
      const destination = stops[next];
      if (!destination) return;
      moveTo(destination, destination);
    },
    [moveTo, sync]
  );

  return { ref, onKeyDown };
}
