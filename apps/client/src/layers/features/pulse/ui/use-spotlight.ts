import { useState, useCallback } from 'react';
import { useReducedMotion } from 'motion/react';

interface SpotlightPosition {
  x: number;
  y: number;
}

interface SpotlightResult {
  /** Current cursor position relative to the element. */
  position: SpotlightPosition;
  /** Whether the spotlight is currently visible (mouse is over). */
  isActive: boolean;
  /** Attach to onMouseMove on the target element. */
  onMouseMove: (e: React.MouseEvent<HTMLElement>) => void;
  /** Attach to onMouseLeave on the target element. */
  onMouseLeave: () => void;
  /** CSS background style for the radial gradient overlay. */
  spotlightStyle: React.CSSProperties | undefined;
}

/**
 * Mouse-tracking radial gradient that follows the cursor across a card.
 *
 * Disabled when `prefers-reduced-motion` is set or on touch-only devices
 * (detected via matchMedia hover check).
 */
export function useSpotlight(): SpotlightResult {
  const [position, setPosition] = useState<SpotlightPosition>({ x: 0, y: 0 });
  const [isActive, setIsActive] = useState(false);
  const reducedMotion = useReducedMotion();

  // Disable on touch-only devices
  const isTouchOnly = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(hover: none)').matches;

  const disabled = reducedMotion || isTouchOnly;

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (disabled) return;
      const rect = e.currentTarget.getBoundingClientRect();
      setPosition({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      setIsActive(true);
    },
    [disabled]
  );

  const onMouseLeave = useCallback(() => {
    setIsActive(false);
  }, []);

  const spotlightStyle: React.CSSProperties | undefined =
    !disabled && isActive
      ? {
          background: `radial-gradient(350px circle at ${position.x}px ${position.y}px, rgba(59,130,246,0.06), transparent 80%)`,
        }
      : undefined;

  return { position, isActive, onMouseMove, onMouseLeave, spotlightStyle };
}
