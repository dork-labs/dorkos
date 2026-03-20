/// <reference types="@testing-library/jest-dom" />
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { vi } from 'vitest';

// Motion-specific props to strip so they don't leak to the DOM.
const MOTION_PROPS = new Set([
  'initial', 'animate', 'exit', 'transition', 'variants', 'custom',
  'whileHover', 'whileTap', 'whileFocus', 'whileDrag', 'whileInView',
  'drag', 'dragConstraints', 'dragElastic', 'dragMomentum', 'dragTransition',
  'dragPropagation', 'dragSnapToOrigin', 'dragListener',
  'onDragStart', 'onDrag', 'onDragEnd', 'onDirectionLock',
  'onAnimationStart', 'onAnimationComplete', 'onUpdate',
  'layout', 'layoutId', 'layoutDependency', 'layoutScroll',
  'onLayoutAnimationStart', 'onLayoutAnimationComplete',
  'onViewportEnter', 'onViewportLeave',
]);

/** Strip motion props and render a plain HTML element. */
function stripMotionProps(allProps: Record<string, unknown>) {
  const filtered: Record<string, unknown> = {};
  for (const key in allProps) {
    if (!MOTION_PROPS.has(key) && key !== 'children') {
      filtered[key] = allProps[key];
    }
  }
  return filtered;
}

/**
 * Build a stable mock component for a given HTML tag.
 * Using a cache ensures React sees the same component type across renders,
 * preventing unnecessary remounts.
 */
const componentCache = new Map<string, React.FC<Record<string, unknown>>>();

function getMotionComponent(tag: string): React.FC<Record<string, unknown>> {
  let comp = componentCache.get(tag);
  if (!comp) {
    // eslint-disable-next-line react/display-name
    comp = React.forwardRef(
      (allProps: Record<string, unknown>, ref: React.Ref<unknown>) => {
        const { children, onAnimationComplete, ...rest } = allProps;
        const filtered = stripMotionProps(rest);

        // Invoke onAnimationComplete immediately so tests relying on it work.
        React.useEffect(() => {
          if (typeof onAnimationComplete === 'function') {
            (onAnimationComplete as () => void)();
          }
        }, [onAnimationComplete]);

        const Tag = tag as keyof React.JSX.IntrinsicElements;
        // eslint-disable-next-line react-hooks/refs -- test mock: ref forwarding is intentional
        return React.createElement(Tag, { ...filtered, ref }, children as React.ReactNode);
      },
    ) as unknown as React.FC<Record<string, unknown>>;
    componentCache.set(tag, comp);
  }
  return comp;
}

// Global mock for motion/react — renders plain HTML elements without animation props.
// Eliminates the need to duplicate this mock in every component test file.
vi.mock('motion/react', () => ({
  motion: new Proxy(
    {},
    {
      get: (_target: unknown, prop: string) => getMotionComponent(prop),
    },
  ),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  LayoutGroup: ({ children }: { children: React.ReactNode }) => children,
  MotionConfig: ({ children }: { children: React.ReactNode }) => children,
  useReducedMotion: () => false,
}));
