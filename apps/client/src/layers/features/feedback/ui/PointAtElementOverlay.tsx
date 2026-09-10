import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type MouseEvent,
  type WheelEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Crosshair } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

/** Which half of the gesture the overlay is in. */
export type PointAtElementPhase = 'picking' | 'capturing';

interface PointAtElementOverlayProps {
  /** `picking` while it waits for a click; `capturing` once the picture is being taken. */
  phase: PointAtElementPhase;
  /** The element the person clicked. */
  onSelect: (element: Element) => void;
  /** They changed their mind — put the dialog back exactly as it was. */
  onCancel: () => void;
}

/**
 * How dark the rest of the app goes while one element is lit up.
 *
 * Painted as an enormous spread on the highlight box's own shadow rather than as
 * a full-screen layer with a hole in it — one element, no stacking to reason
 * about, and the hole can never drift out of register with the outline because it
 * IS the outline. `bg-black/50` is the scrim every other overlay in the design
 * system uses; this is that value, in the one place Tailwind cannot spell it.
 */
const SCRIM = '0 0 0 9999px rgb(0 0 0 / 0.5)';

/** What the pill above the highlight says. */
function labelFor(element: Element): string {
  // Deliberately NOT the full selector: naming an element precisely means
  // querying the document once per candidate path, and this runs on every
  // pointer move. The precise name is computed once, on the click.
  const slot = element.closest('[data-slot]')?.getAttribute('data-slot');
  const testId = element.closest('[data-testid]')?.getAttribute('data-testid');
  return testId ?? slot ?? element.tagName.toLowerCase();
}

/**
 * The nearest thing at or above this element that a wheel could scroll.
 *
 * The picker covers the viewport, so every wheel event is delivered to the picker
 * — and a fixed, non-scrolling box scrolls the DOCUMENT, not the pane the pointer
 * happens to be over. In this app almost nothing lives in a scrolling document:
 * the shell fills the window and the content scrolls inside panes. So without
 * this, everything below the fold of every pane is unreachable the moment aiming
 * starts, which is most of what a person might want to point at.
 *
 * @param element - Where to start looking, usually whatever is under the pointer.
 * @returns The element to scroll, or `null` when nothing up the chain scrolls.
 */
function scrollableAncestor(element: Element | null): Element | null {
  let node: Element | null = element;
  while (node) {
    const canOverflow = /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY);
    if (canOverflow && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

/** The element the pointer is over, and where to draw its box. */
interface Target {
  /** The element itself, so a click can be resolved without a second lookup. */
  element: Element;
  /** Its box in the viewport, in CSS pixels. */
  box: { left: number; top: number; width: number; height: number };
  /** The short name shown in the pill. */
  label: string;
}

/**
 * Point at the part of the app that looks wrong, and send a report about that
 * part (feedback-attachments decision 9).
 *
 * A full-viewport picker: the app dims, whatever is under the pointer lights up
 * with its name, and one click takes a cropped picture of it and hands the
 * feedback dialog back with the picture and the element's name already in the
 * report.
 *
 * **It swallows every pointer event, and every key but one, on purpose.** The
 * overlay is the topmost hit target, so nothing underneath can be clicked,
 * hovered or dragged while a person is aiming — which is the whole reason this is
 * safe to offer over a live app rather than a screenshot of one. The keyboard
 * gets the same treatment for the same reason: without it, Tab walks focus into
 * an app nobody can see the focus ring in, Enter presses whatever it landed on,
 * and every global shortcut still fires — ⌘K opens a command palette UNDER the
 * picker, which then cannot be clicked and whose own Escape this overlay eats.
 * So focus moves here on mount and goes back where it was on unmount, and while
 * aiming the only key that means anything is Escape.
 *
 * That leaves the visible Cancel button reachable by pointer only, which is the
 * honest shape of a pointer gesture: Escape is the keyboard's way out, and the
 * bar says so in the words a person needs.
 *
 * The reach of that has one edge worth knowing. This listener sits on `window`
 * in the CAPTURE phase, so it runs before propagation reaches `document` — which
 * is where all three of the app's global shortcuts live, in the bubble phase, so
 * all three are stopped. A rival listener that took the same position and
 * registered FIRST would run before this one and could not be stopped by
 * anything here; nothing in the app does, and anything that did would have to
 * check for the picker itself.
 *
 * **Finding out WHAT is underneath takes one deliberate step**: hit-testing is
 * turned off for the length of a single `elementFromPoint` call and turned
 * straight back on. Asking the browser without that would only ever answer "the
 * overlay". The wheel is forwarded by hand for the same reason — see
 * {@link scrollableAncestor}.
 *
 * **Nothing can be shown while the picture is being taken.** The capture fades
 * every child of `<body>` to nothing so the photograph is of the app alone, and
 * this picker is one of those children — so a progress cue here is painted at
 * zero opacity for its whole life (measured in a real Chromium; the browser spec
 * samples it), and a cue anywhere it WOULD be visible is a cue in the
 * photograph. The same truth `app-capture.ts` states about the dialog therefore
 * holds for the picker: during the capture there is no honest thing to show, so
 * nothing is offered but the wait cursor, which survives because a faded element
 * still hit-tests. What bounds that state is `APP_CAPTURE_TIMEOUT_MS`, not a
 * spinner.
 *
 * **A click cannot be taken back once it is a capture.** The capture is not
 * cancellable underneath (neither snapdom nor an IPC round-trip is), so Escape
 * and right-click stand down the moment aiming ends. Accepting a cancel there
 * would put the dialog back on screen mid-photograph, as a fresh `<body>` child
 * the capture's hide sweep never saw — and the desktop shell would photograph
 * it, which is the exact failure that sweep exists to prevent.
 *
 * **Spec deviation, recorded:** decision 9 says "Escape or click-outside
 * cancels". A picker that covers the viewport has no outside to click, so
 * click-outside became right-click — the other reflex for "not this" — beside
 * Escape and the visible Cancel button.
 *
 * Pointer-only by nature, and offered a layer up in `ScreenshotField` only on a
 * wide viewport — the gate there is a 768px media query, not a touch test, and
 * that TSDoc says why the approximation is the right shape.
 */
export function PointAtElementOverlay({ phase, onSelect, onCancel }: PointAtElementOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const picking = phase === 'picking';

  /**
   * What is under this point in the APP, rather than the overlay covering it.
   *
   * The overlay stops hit-testing for exactly the length of the lookup.
   * `elementFromPoint` flushes pending style, so the toggle is in effect for the
   * call it wraps and nothing paints in between — the person never sees a frame
   * in which the picker was not there. Restored in a `finally` because a throw
   * that left it off would hand every later click straight to the live app.
   */
  const elementUnder = useCallback((x: number, y: number): Element | null => {
    const root = rootRef.current;
    if (!root) return null;
    const previous = root.style.pointerEvents;
    root.style.pointerEvents = 'none';
    try {
      return document.elementFromPoint(x, y);
    } finally {
      root.style.pointerEvents = previous;
    }
  }, []);

  /** Whether a point is over the picker's own controls rather than over the app. */
  const overOwnControls = useCallback((eventTarget: EventTarget | null): boolean => {
    return eventTarget instanceof Node && Boolean(hintRef.current?.contains(eventTarget));
  }, []);

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!picking) return;
      // Over the Cancel bar there is nothing being aimed at, and lighting up
      // whatever happens to sit behind the bar would be pointing at a lie.
      if (overOwnControls(event.target)) {
        setTarget(null);
        return;
      }
      const found = elementUnder(event.clientX, event.clientY);
      if (!found) {
        setTarget(null);
        return;
      }
      const box = found.getBoundingClientRect();
      setTarget({
        element: found,
        box: { left: box.left, top: box.top, width: box.width, height: box.height },
        label: labelFor(found),
      });
    },
    [picking, elementUnder, overOwnControls]
  );

  const onClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!picking) return;
      if (overOwnControls(event.target)) return;
      // Resolve fresh rather than trusting the last hover: a click can arrive
      // without a preceding move (a tap on a trackpad, a synthetic click), and
      // "nothing was hovered" must not swallow a deliberate press.
      const found = elementUnder(event.clientX, event.clientY) ?? target?.element;
      if (found) onSelect(found);
    },
    [picking, elementUnder, overOwnControls, onSelect, target]
  );

  /** Hand the wheel to the pane the pointer is over, which never sees it itself. */
  const onWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (!picking) return;
      const pane = scrollableAncestor(elementUnder(event.clientX, event.clientY));
      pane?.scrollBy({ left: event.deltaX, top: event.deltaY });
    },
    [picking, elementUnder]
  );

  // Take the keyboard for as long as aiming lasts. Escape gets out; everything
  // else stops here, including the app's global shortcuts —
  // `stopImmediatePropagation` rather than `stopPropagation` because those
  // listeners sit on `window` too, and capture-phase siblings would otherwise
  // still run. Bound only while PICKING: a capture cannot be called off, so a
  // press during one must not reopen the dialog into the photograph.
  useEffect(() => {
    if (!picking) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [picking, onCancel]);

  // Focus comes here and goes back. Without the first half, `aria-modal` is a
  // claim contradicted by a focus ring sitting in the app behind the picker;
  // without the second, cancelling drops the person's caret on the floor and the
  // report they were writing loses its cursor.
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    rootRef.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  // A highlight is drawn from a rect measured when the pointer last moved, and a
  // scroll moves the box without moving the pointer — so the outline would sit
  // over whatever slid into its place. Re-measured from the element itself, which
  // is why `Target` keeps the node and not only its geometry.
  useEffect(() => {
    if (!picking) return;
    const onScroll = () => {
      setTarget((current) => {
        if (!current) return current;
        const box = current.element.getBoundingClientRect();
        return {
          ...current,
          box: { left: box.left, top: box.top, width: box.width, height: box.height },
        };
      });
    };
    // Capture phase: a scroll inside a pane does not bubble to `window`, and the
    // panes are where this app actually scrolls.
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [picking]);

  const aiming = picking ? target : null;
  // Above the box normally, below it when the box is against the top of the
  // window and there is no room — a label off the top of the screen names nothing.
  const labelBelow = aiming !== null && aiming.box.top < 28;

  return createPortal(
    // The pointer-capture surface, and unavoidably a mouse-only one: the gesture
    // IS "aim at a place on screen", which has no keyboard equivalent to add. The
    // keyboard is served instead by Escape, and focus lives on this element for
    // as long as the picker does — see the effects above.
    /* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events -- pointer-only picker; see above */
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="Point at the part of the app that looks wrong"
      tabIndex={-1}
      className={cn(
        'fixed inset-0 z-50 focus:outline-none',
        picking ? 'cursor-crosshair' : 'cursor-wait'
      )}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setTarget(null)}
      onClick={onClick}
      onWheel={onWheel}
      onContextMenu={(event) => {
        // A right-click is the other reflex for "not this, get me out" — and,
        // with no outside to click, it is what stands in for click-outside.
        event.preventDefault();
        if (picking) onCancel();
      }}
    >
      {/* Nothing at all once the capture starts. Not an omission — a cue here is
          painted at zero for the whole capture, and a cue anywhere it would show
          is a cue in the photograph. See this component's own doc comment. */}
      {picking &&
        (aiming ? (
          <>
            <div
              className="border-primary pointer-events-none absolute rounded-sm border-2"
              style={{
                left: aiming.box.left,
                top: aiming.box.top,
                width: aiming.box.width,
                height: aiming.box.height,
                boxShadow: SCRIM,
              }}
            />
            <div
              className="bg-primary text-primary-foreground pointer-events-none absolute max-w-[60vw] truncate rounded-sm px-1.5 py-0.5 font-mono text-[11px] leading-tight"
              style={{
                left: Math.max(4, aiming.box.left),
                top: labelBelow ? aiming.box.top + aiming.box.height + 4 : aiming.box.top - 22,
              }}
            >
              {aiming.label}
            </div>
          </>
        ) : (
          // Nothing under the pointer yet, so the app dims whole — the picker is
          // visibly in charge before the first move.
          <div className="absolute inset-0 bg-black/50" />
        ))}

      {picking && (
        /* A click landing in here is the bar's own — the pick handler above reads
           the same containment and steps aside, so nothing has to be stopped. */
        <div
          ref={hintRef}
          className="bg-popover text-popover-foreground absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-lg border px-3 py-2 shadow-lg"
        >
          <span className="flex items-center gap-2 text-xs">
            <Crosshair className="size-3.5 shrink-0" aria-hidden />
            Click the part that looks wrong. Esc to cancel.
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm text-xs underline underline-offset-2 transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none"
          >
            Cancel
          </button>
        </div>
      )}
    </div>,
    document.body
  );
}
