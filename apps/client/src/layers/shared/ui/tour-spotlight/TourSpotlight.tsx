import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { TourProvider, type StepType } from '@reactour/tour';

import { tourAnchorSelector, type TourStep } from '@/layers/shared/config';
import { useIsMobile } from '@/layers/shared/model';

import { TourCaption } from './TourCaption';
import { useAnchorResolver } from './use-anchor-resolver';
import { useFocusTrap } from './use-focus-trap';
import { usePrefersReducedMotion } from './use-prefers-reduced-motion';

/** CSS class applied to the mask when the user prefers reduced motion. */
const REDUCED_MOTION_MASK_CLASS = 'dork-tour-mask--reduced-motion';

/** Padding around the spotlight cutout and between it and the caption. */
const SPOTLIGHT_PADDING = { mask: 8, popover: 10 } as const;

/**
 * Eased glide applied to the spotlight cutout's geometry so it slides from one
 * element to the next between steps. reactour renders the cutout as an SVG rect
 * whose x/y/width/height are set as inline styles, so a CSS transition on those
 * geometry properties animates the move (the reduced-motion mask class stills it
 * via `transition: none !important`).
 */
const MASK_GEOMETRY_TRANSITION = 'x 280ms ease, y 280ms ease, width 280ms ease, height 280ms ease';

/** Props for the controlled spotlight. The engine owns the step index. */
export interface TourSpotlightProps {
  /** The ordered steps of the running tour. */
  steps: TourStep[];
  /** Which step is active. The engine advances it. */
  activeIndex: number;
  /** Move to the next step (called on chip-advance and on anchor timeout). */
  onAdvance: () => void;
  /** End the tour (Esc, click-outside, the caption's Done chip). */
  onEnd: () => void;
}

/**
 * The DorkBot spotlight primitive: dim the app, cut out one real element, and
 * float DorkBot's caption beside it. A controlled wrapper over `@reactour/tour`
 * (ADR 260722-154340) — it owns anchor resolution (poll + timeout-skip),
 * scroll-into-view, the custom caption, and the full accessibility bar (our own
 * `aria-live` announcer, focus trap, an `inert` background, Esc and click-outside
 * to exit, and a reduced-motion branch that stills the cutout). It holds no tour
 * state: the engine drives `activeIndex` and reacts to `onAdvance`/`onEnd`.
 *
 * Movement between steps glides: reactour freezes its `steps` prop into internal
 * state at mount, so the cutout is moved with reactour's controlled `currentStep`
 * prop rather than by remounting the provider each step. The provider remounts
 * only when the tour itself changes (its anchors differ), which keeps the cutout
 * rect mounted across a step advance so the CSS geometry transition can animate
 * it instead of popping in from the corner. The shown step follows `activeIndex`
 * only once that step's anchor resolves, so the previous element stays lit during
 * the resolve gap and the glide runs element-to-element.
 *
 * The overlay and announcer render into a portal on `document.body` so the app
 * root can go `inert` behind them without disabling the tour itself.
 */
export function TourSpotlight({ steps, activeIndex, onAdvance, onEnd }: TourSpotlightProps) {
  const currentStep = steps[activeIndex] as TourStep | undefined;
  const isLast = activeIndex >= steps.length - 1;
  const isMobile = useIsMobile();
  const reducedMotion = usePrefersReducedMotion();
  const resolution = useAnchorResolver(currentStep?.anchor ?? null);

  // The step the spotlight currently paints. It follows `activeIndex` only once
  // that step's anchor resolves 'found', so the previous element stays lit during
  // the brief resolve gap and the cutout glides to the next once it lands. Both
  // transitions use React's "adjust state during render" pattern (mirroring the
  // anchor resolver) so they never ride an effect, and each converges in one pass.
  const [shownIndex, setShownIndex] = useState<number | null>(null);
  if (
    resolution.status === 'found' &&
    resolution.element !== null &&
    // Only a resolution for the CURRENT step's anchor promotes it. During the
    // render where activeIndex advances, the resolver still returns the previous
    // step's `found` (its reset is one render behind), so this guard keeps the
    // shown step trailing until the new anchor genuinely resolves.
    resolution.anchor === currentStep?.anchor &&
    shownIndex !== activeIndex
  ) {
    setShownIndex(activeIndex);
  } else if (!currentStep && shownIndex !== null) {
    // The tour ended (no current step): drop the spotlight so a relaunch is fresh.
    setShownIndex(null);
  }

  const active = shownIndex !== null;
  const shownStep = shownIndex !== null ? (steps[shownIndex] as TourStep | undefined) : undefined;

  // Advance is called on chip-click and on anchor timeout. A latest-value ref
  // lets the timeout effect depend only on the status, without re-firing every
  // render as the callback identities change.
  const handleAdvance = useCallback(() => {
    if (isLast) onEnd();
    else onAdvance();
  }, [isLast, onEnd, onAdvance]);

  const advanceRef = useRef(handleAdvance);
  useEffect(() => {
    advanceRef.current = handleAdvance;
  }, [handleAdvance]);

  useEffect(() => {
    if (resolution.status === 'timeout') advanceRef.current();
  }, [resolution.status]);

  // Latest engine callbacks in refs so the per-step captions (baked once per tour)
  // always drive current behavior without rebuilding the reactour steps array.
  const onAdvanceRef = useRef(onAdvance);
  const onEndRef = useRef(onEnd);
  useEffect(() => {
    onAdvanceRef.current = onAdvance;
    onEndRef.current = onEnd;
  }, [onAdvance, onEnd]);

  // Whether a keyboard advance is allowed right now — true only when the shown
  // step has caught up to `activeIndex`. reactour re-registers its keydown
  // listener only when its `currentStep` prop changes, but we hold that during
  // the resolve gap, so its captured handler is stale; reading a ref keeps the
  // gate (and the advance) current regardless of when reactour last bound it.
  const canAdvanceRef = useRef(false);
  useEffect(() => {
    canAdvanceRef.current = shownIndex === activeIndex;
  }, [shownIndex, activeIndex]);

  // Enable the cutout glide only after the first step has painted, so the first
  // spotlight appears in place instead of sweeping in from the top-left corner.
  const [glide, setGlide] = useState(false);
  useEffect(() => {
    if (active && !glide) {
      const id = requestAnimationFrame(() => setGlide(true));
      return () => cancelAnimationFrame(id);
    }
  }, [active, glide]);

  // Make the app behind the overlay inert while a step is spotlighted. The
  // overlay is portaled to <body>, outside #root, so it stays interactive.
  useEffect(() => {
    if (!active) return;
    const root = document.getElementById('root');
    if (!root) return;
    root.inert = true;
    return () => {
      root.inert = false;
    };
  }, [active]);

  // Own the focus trap: reactour 3.8.0 ships none. Backed by the inert background.
  useFocusTrap(active, shownIndex ?? -1);

  const popoverStyle = useMemo(() => {
    return (base: { [key: string]: unknown }): CSSProperties => {
      const stripped: CSSProperties = {
        ...(base as CSSProperties),
        backgroundColor: 'transparent',
        padding: 0,
        boxShadow: 'none',
        maxWidth: 'none',
        color: 'inherit',
      };
      if (!isMobile) return stripped;
      return {
        ...stripped,
        position: 'fixed',
        top: 'auto',
        left: 0,
        right: 0,
        bottom: 0,
        transform: 'none',
        display: 'flex',
        justifyContent: 'center',
        padding: '0 1rem 1rem',
      };
    };
  }, [isMobile]);

  // Glide only the visible cutout (maskArea). The highlighted-area rect is left to
  // reactour so its interaction-gating display logic is preserved. reactour's
  // maskArea style carries the geometry props (including a numeric `rx`), so the
  // signature mirrors its type rather than a plain CSSProperties.
  const maskAreaStyle = useCallback(
    (base: CSSProperties & { rx?: number }): CSSProperties & { rx?: number } =>
      glide ? { ...base, transition: MASK_GEOMETRY_TRANSITION } : base,
    [glide]
  );

  const styles = useMemo(
    () => ({ popover: popoverStyle, maskArea: maskAreaStyle }),
    [popoverStyle, maskAreaStyle]
  );

  // Build the full reactour step list once per tour. reactour freezes `steps` into
  // internal state at mount, so movement is driven by the controlled `currentStep`
  // prop; the captions are baked here and route through refs to stay current.
  const reactourSteps = useMemo<StepType[]>(
    () =>
      steps.map((step, i) => {
        const last = i === steps.length - 1;
        return {
          selector: tourAnchorSelector(step.anchor),
          stepInteraction: false,
          content: (
            <TourCaption
              caption={step.caption}
              chipLabel={step.chipLabel}
              isLast={last}
              onAdvance={() => (last ? onEndRef.current() : onAdvanceRef.current())}
              onEnd={() => onEndRef.current()}
            />
          ),
        };
      }),
    [steps]
  );

  // Remount the provider only when the tour itself changes (its anchors differ),
  // never on a step advance — that keeps the cutout rect mounted so it can glide.
  const tourKey = useMemo(() => steps.map((s) => s.anchor).join('|'), [steps]);

  if (!currentStep) return null;

  return createPortal(
    <>
      {/* Our announcer: names the target so a screen reader hears each step. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {active ? (shownStep?.caption ?? '') : ''}
      </div>
      {active && (
        <TourProvider
          key={tourKey}
          steps={reactourSteps}
          // Controlled: the engine (via our resolver gate) owns the shown step, so
          // reactour re-measures and the cutout glides without a remount.
          currentStep={shownIndex ?? 0}
          defaultOpen
          // No scrollSmooth: the resolver already scrolls the target into view
          // before opening, so reactour's own smooth-scroll (and the transition
          // state it drives) never runs on first open — one less first-mount race.
          showNavigation={false}
          showPrevNextButtons={false}
          showCloseButton={false}
          showBadge={false}
          showDots={false}
          disableInteraction
          padding={SPOTLIGHT_PADDING}
          styles={styles}
          maskClassName={reducedMotion ? REDUCED_MOTION_MASK_CLASS : undefined}
          onClickMask={() => onEnd()}
          keyboardHandler={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onEndRef.current();
            } else if (e.key === 'ArrowRight' && canAdvanceRef.current) {
              // Only advance a step the operator can actually see: during the
              // resolve gap the shown step trails `activeIndex`, and a fast
              // ArrowRight would otherwise skip a step that never painted. Refs,
              // not the captured closure, because reactour's listener is stale
              // while we hold its currentStep during the gap.
              advanceRef.current();
            }
          }}
        >
          <span className="hidden" aria-hidden />
        </TourProvider>
      )}
    </>,
    document.body
  );
}
