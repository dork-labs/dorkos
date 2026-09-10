import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type MouseEvent,
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
 * **It swallows every pointer event on purpose.** The overlay is the topmost hit
 * target, so nothing underneath can be clicked, hovered, or dragged while a
 * person is aiming — which is the whole reason this is safe to offer over a live
 * app rather than a screenshot of one. Finding out WHAT is underneath therefore
 * takes one deliberate step: hit-testing is turned off for the length of a single
 * `elementFromPoint` call and turned straight back on. Asking the browser
 * without that would only ever answer "the overlay".
 *
 * The one thing that costs: a scroll wheel over the overlay scrolls the page, not
 * the app's inner panes, because the pane never sees the event. Pointing at
 * something is a short gesture aimed at what is already on screen — the dialog
 * that was covering it has just moved out of the way — so the trade lands on the
 * right side, and the alternative (a pass-through overlay) gives the app back its
 * hover states and its click handlers, which is a far worse thing to have
 * happening under a picker.
 *
 * Pointer-only by nature, and hidden on touch a layer up in `ScreenshotField` —
 * there is no touch gesture that means "hover to aim, then commit".
 */
export function PointAtElementOverlay({ phase, onSelect, onCancel }: PointAtElementOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<Target | null>(null);

  /**
   * What is under this point in the APP, rather than the overlay covering it.
   *
   * The overlay stops hit-testing for exactly the length of the lookup.
   * `elementFromPoint` flushes pending style, so the toggle is in effect for the
   * call it wraps and nothing paints in between — the person never sees a frame
   * in which the picker was not there.
   */
  const elementUnder = useCallback((x: number, y: number): Element | null => {
    const root = rootRef.current;
    if (!root) return null;
    const previous = root.style.pointerEvents;
    root.style.pointerEvents = 'none';
    const found = document.elementFromPoint(x, y);
    root.style.pointerEvents = previous;
    return found;
  }, []);

  /** Whether a point is over the picker's own controls rather than over the app. */
  const overOwnControls = useCallback((eventTarget: EventTarget | null): boolean => {
    return eventTarget instanceof Node && Boolean(hintRef.current?.contains(eventTarget));
  }, []);

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (phase !== 'picking') return;
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
    [phase, elementUnder, overOwnControls]
  );

  const onClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (phase !== 'picking') return;
      if (overOwnControls(event.target)) return;
      // Resolve fresh rather than trusting the last hover: a click can arrive
      // without a preceding move (a tap on a trackpad, a synthetic click), and
      // "nothing was hovered" must not swallow a deliberate press.
      const found = elementUnder(event.clientX, event.clientY) ?? target?.element;
      if (found) onSelect(found);
    },
    [phase, elementUnder, overOwnControls, onSelect, target]
  );

  // Escape gets out, from anywhere, whatever has focus — and it is taken in the
  // capture phase so no shortcut anywhere else in the app acts on the same press.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  // Nothing is lit up while the picture is being taken: the aiming is over, and
  // a highlight still following the pointer would invite a second click there is
  // nothing left to do with.
  const aiming = phase === 'picking' ? target : null;
  // Above the box normally, below it when the box is against the top of the
  // window and there is no room — a label off the top of the screen names nothing.
  const labelBelow = aiming !== null && aiming.box.top < 28;

  return createPortal(
    // The pointer-capture surface, and unavoidably a mouse-only one: the gesture
    // IS "aim at a place on screen", which has no keyboard equivalent to add. The
    // keyboard is served instead by the two ways out that both work from here —
    // Escape (bound at the window, above) and the focusable Cancel button — and
    // the affordance that opens this is hidden on touch a layer up.
    /* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events -- pointer-only picker; see above */
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="Point at the part of the app that looks wrong"
      className={cn('fixed inset-0 z-50', phase === 'picking' ? 'cursor-crosshair' : 'cursor-wait')}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setTarget(null)}
      onClick={onClick}
      onContextMenu={(event) => {
        // A right-click is the other reflex for "not this, get me out".
        event.preventDefault();
        onCancel();
      }}
    >
      {aiming ? (
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
        // Nothing under the pointer yet — or the picture is being taken. The app
        // still dims, so the picker is visibly in charge either way.
        <div className="absolute inset-0 bg-black/50" />
      )}

      {/* A click landing in here is the bar's own — the pick handler above reads
          the same containment and steps aside, so nothing has to be stopped. */}
      <div
        ref={hintRef}
        className="bg-popover text-popover-foreground absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-lg border px-3 py-2 shadow-lg"
      >
        <span className="flex items-center gap-2 text-xs">
          <Crosshair className="size-3.5 shrink-0" aria-hidden />
          <span role="status" aria-live="polite">
            {phase === 'capturing'
              ? 'Taking the picture…'
              : 'Click the part that looks wrong. Esc to cancel.'}
          </span>
        </span>
        {phase === 'picking' && (
          <button
            type="button"
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm text-xs underline underline-offset-2 transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none"
          >
            Cancel
          </button>
        )}
      </div>
    </div>,
    document.body
  );
}
