/**
 * Shared motion vocabulary for generative-UI widgets — the timing tokens,
 * entrance variants, and hooks every node animates with, so the whole surface
 * moves as one coherent system: fast, precise, calm-tech. Not bouncy, not showy;
 * content arrives with intent and settles.
 *
 * Every animation here is gated on {@link useWidgetMotion} so a user who prefers
 * reduced motion gets the final state instantly, never a frozen half-state.
 *
 * @module features/gen-ui/lib/widget-motion
 */
import { useEffect, useRef, useState } from 'react';
import { animate, useReducedMotion } from 'motion/react';
import type { Transition, Variants } from 'motion/react';

/** Spring for content settling into place — snappy, well damped, no visible bounce. */
export const WIDGET_SPRING: Transition = { type: 'spring', stiffness: 400, damping: 32, mass: 0.8 };

/** Expo-out curve for draws and fills that should decelerate hard without overshooting. */
export const WIDGET_EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** Seconds between each sibling's entrance in a staggered container. */
export const WIDGET_STAGGER_STEP = 0.05;

/** Duration (seconds) of the chart/number draw-on animations. */
export const WIDGET_DRAW_DURATION = 0.9;

/** A single node's entrance: rise + fade + a hair of scale, settling on the spring. */
export const widgetEntrance: Variants = {
  hidden: { opacity: 0, y: 6, scale: 0.985 },
  visible: { opacity: 1, y: 0, scale: 1, transition: WIDGET_SPRING },
};

/** Container that releases its children's {@link widgetEntrance} one after another. */
export const widgetStaggerContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: WIDGET_STAGGER_STEP } },
};

/**
 * Whether widget motion should play. Thin wrapper over motion's
 * `useReducedMotion` so every node has one testable switch — `false` means
 * "render final states instantly".
 */
export function useWidgetMotion(): boolean {
  return !useReducedMotion();
}

/**
 * Animate a number from its current displayed value up to `target` with the
 * widget ease-out curve, re-rendering each frame. Retargets mid-flight animate
 * from wherever the count currently is. When motion is disabled it snaps to
 * `target` immediately.
 *
 * @param target - The value to count to.
 * @param enabled - Whether to animate (pass {@link useWidgetMotion}'s result).
 * @param durationMs - Total count time; defaults to {@link WIDGET_DRAW_DURATION}.
 * @returns The current (possibly fractional) display value.
 */
export function useCountUp(
  target: number,
  enabled: boolean,
  durationMs = WIDGET_DRAW_DURATION * 1000
): number {
  const [display, setDisplay] = useState(() => (enabled ? 0 : target));
  const current = useRef(enabled ? 0 : target);

  useEffect(() => {
    if (!enabled) {
      current.current = target;
      setDisplay(target);
      return;
    }
    const controls = animate(current.current, target, {
      duration: durationMs / 1000,
      ease: WIDGET_EASE_OUT,
      onUpdate: (value) => {
        current.current = value;
        setDisplay(value);
      },
    });
    return () => controls.stop();
  }, [target, enabled, durationMs]);

  return display;
}
