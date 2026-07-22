import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { TourProvider, type StepType } from '@reactour/tour';

import type { TourStep } from '@/layers/shared/config';
import { useIsMobile } from '@/layers/shared/model';

import { TourCaption } from './TourCaption';
import { useAnchorResolver } from './use-anchor-resolver';
import { useFocusTrap } from './use-focus-trap';
import { usePrefersReducedMotion } from './use-prefers-reduced-motion';

/** CSS class applied to the mask when the user prefers reduced motion. */
const REDUCED_MOTION_MASK_CLASS = 'dork-tour-mask--reduced-motion';

/** Padding around the spotlight cutout and between it and the caption. */
const SPOTLIGHT_PADDING = { mask: 8, popover: 10 } as const;

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
 * The overlay and announcer render into a portal on `document.body` so the app
 * root can go `inert` behind them without disabling the tour itself.
 */
export function TourSpotlight({ steps, activeIndex, onAdvance, onEnd }: TourSpotlightProps) {
  const currentStep = steps[activeIndex] as TourStep | undefined;
  const isLast = activeIndex >= steps.length - 1;
  const isMobile = useIsMobile();
  const reducedMotion = usePrefersReducedMotion();
  const resolution = useAnchorResolver(currentStep?.anchor ?? null);
  const overlayActive = resolution.status === 'found' && resolution.element !== null;

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

  // Make the app behind the overlay inert while a step is spotlighted. The
  // overlay is portaled to <body>, outside #root, so it stays interactive.
  useEffect(() => {
    if (resolution.status !== 'found') return;
    const root = document.getElementById('root');
    if (!root) return;
    root.inert = true;
    return () => {
      root.inert = false;
    };
  }, [resolution.status]);

  // Own the focus trap: reactour 3.8.0 ships none. Backed by the inert background.
  useFocusTrap(overlayActive, activeIndex);

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

  const styles = useMemo(() => ({ popover: popoverStyle }), [popoverStyle]);

  if (!currentStep) return null;

  const reactourSteps: StepType[] = overlayActive
    ? [
        {
          selector: resolution.element as Element,
          stepInteraction: false,
          content: (
            <TourCaption
              caption={currentStep.caption}
              chipLabel={currentStep.chipLabel}
              isLast={isLast}
              onAdvance={handleAdvance}
              onEnd={onEnd}
            />
          ),
        },
      ]
    : [];

  return createPortal(
    <>
      {/* Our announcer: names the target so a screen reader hears each step. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {overlayActive ? currentStep.caption : ''}
      </div>
      {overlayActive && (
        <TourProvider
          key={activeIndex}
          steps={reactourSteps}
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
              onEnd();
            } else if (e.key === 'ArrowRight') {
              handleAdvance();
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
