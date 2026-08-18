/// <reference types="@testing-library/jest-dom" />
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterAll, afterEach, vi } from 'vitest';

// React work must not outlive the test that scheduled it.
//
// The failure it prevents, seen twice in CI and never locally: every test in
// `@dorkos/client` passes, and the run still fails with one unhandled error —
//
//   ReferenceError: window is not defined
//     at performWorkOnRootViaSchedulerTask (react-dom-client.development.js)
//     at performWorkUntilDeadline (scheduler.development.js)
//     at process.processImmediate (node:internal/timers)
//
// — attributed to a different test file each time, because it is a race, not a
// bad test. React's scheduler queues its work loop with `setImmediate` (jsdom
// exposes it, so React prefers it over MessageChannel), and the first thing
// `performWorkOnRootViaSchedulerTask` reads is the bare global `window`. Vitest
// deletes that global when it tears the jsdom environment down — measured here
// at roughly nine immediate ticks after a file's last hook, with the worker
// still alive and still draining immediates. Any React task still queued at
// that moment fires into a dead window.
//
// Instrumenting a full run showed 26 of 643 files ending with exactly one
// queued `performWorkUntilDeadline`, and 146 leaving their React trees mounted
// (Vitest runs without `globals`, so `typeof afterEach === 'undefined'` at
// import time and Testing Library never registers its own auto-cleanup). So the
// discipline is both halves, in order:
//
//   1. Unmount every tree, so nothing can schedule more work.
//   2. Yield one immediate tick. Immediates are FIFO, so anything React already
//      queued runs here — while `window` still exists.
//
// Hooks registered in a setup file run last (Vitest unwinds hooks in reverse
// registration order), so a file's own cleanup happens before this flush. The
// `afterAll` pass is a second drain tick: React's work loop re-queues itself
// when it runs past its 5ms frame budget, so one file-final tick can end with
// its continuation still queued.
//
// The immediate is captured here, at setup time, on purpose: `vi.useFakeTimers()`
// swaps the global one out, and a flush that queued into a frozen clock would
// hang until the hook times out. React's scheduler captured the real one at its
// own module load for the same reason, so this drains the queue React uses.
const scheduleImmediate = globalThis.setImmediate;
const flushScheduledWork = () => new Promise<void>((resolve) => scheduleImmediate(resolve));

afterEach(async () => {
  // Testing Library is imported here, not at the top, so that a test file with
  // no React in it does not pay to load react-dom (~120ms of setup per file
  // when this was a static import). Testing Library renders into containers it
  // appends to `document.body` — including `renderHook` — so an empty body
  // means nothing was mounted. Two things would falsify that: passing `render`
  // its own `container`, which no test here does; and a file that empties the
  // body itself, which detaches its trees without unmounting them and leaves
  // this guard reading false — those files call `cleanup()` before the wipe.
  // Some files opt into `@vitest-environment node`, where there is no document
  // at all.
  if (typeof document !== 'undefined' && document.body.firstChild) {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  }
  await flushScheduledWork();
});

afterAll(async () => {
  await flushScheduledWork();
});

// jsdom has no ResizeObserver; components that observe size (e.g. the canvas
// image zoom/pan surface) need a no-op polyfill to render under test.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

// jsdom implements neither `DragEvent` nor `ClipboardEvent`, and unlike a
// missing method these are missing GLOBALS: code that reaches for one gets a
// `ReferenceError`, not `undefined`. Lexical's `eventFiles` asks
// `objectKlassEquals(event, DragEvent)` on every paste and drop it sees, so a
// single pasted character in a rich-text field throws inside an event listener
// — where it surfaces as an unhandled exception at the END of the run rather
// than as a failing assertion, and the run goes red with every test green.
//
// Both are real browser globals; this is purely an environment gap, so the
// polyfill is a plain subclass that carries the one property each is asked for.
if (!('DragEvent' in globalThis)) {
  globalThis.DragEvent = class DragEvent extends Event {
    readonly dataTransfer: DataTransfer | null;
    constructor(type: string, init: EventInit & { dataTransfer?: DataTransfer | null } = {}) {
      super(type, init);
      this.dataTransfer = init.dataTransfer ?? null;
    }
  } as unknown as typeof DragEvent;
}

if (!('ClipboardEvent' in globalThis)) {
  globalThis.ClipboardEvent = class ClipboardEvent extends Event {
    readonly clipboardData: DataTransfer | null;
    constructor(type: string, init: EventInit & { clipboardData?: DataTransfer | null } = {}) {
      super(type, init);
      this.clipboardData = init.clipboardData ?? null;
    }
  } as unknown as typeof ClipboardEvent;
}

// jsdom declares `window.matchMedia` and leaves it undefined — `'matchMedia' in
// window` is true and calling it throws — so anything that asks the viewport a
// question (`useIsMobile`, reduced motion) dies on mount. The check is therefore
// on the VALUE, not the key. Defaults to the desktop answer; a test that cares
// about the mobile branch redefines this itself.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// Motion-specific props to strip so they don't leak to the DOM.
const MOTION_PROPS = new Set([
  'initial',
  'animate',
  'exit',
  'transition',
  'variants',
  'custom',
  'whileHover',
  'whileTap',
  'whileFocus',
  'whileDrag',
  'whileInView',
  'drag',
  'dragConstraints',
  'dragControls',
  'dragElastic',
  'dragMomentum',
  'dragTransition',
  'dragPropagation',
  'dragSnapToOrigin',
  'dragListener',
  'onDragStart',
  'onDrag',
  'onDragEnd',
  'onDirectionLock',
  'onAnimationStart',
  'onAnimationComplete',
  'onUpdate',
  'layout',
  'layoutId',
  'layoutDependency',
  'layoutScroll',
  'onLayoutAnimationStart',
  'onLayoutAnimationComplete',
  'onViewportEnter',
  'onViewportLeave',
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

/**
 * Build a mock motion component that strips motion props and renders `target`
 * (an HTML tag name, or an arbitrary component passed to `motion.create`).
 */
function makeMotionComponent(
  target: string | React.ElementType
): React.FC<Record<string, unknown>> {
  // eslint-disable-next-line react/display-name
  return React.forwardRef((allProps: Record<string, unknown>, ref: React.Ref<unknown>) => {
    const { children, onAnimationComplete, ...rest } = allProps;
    const filtered = stripMotionProps(rest);

    // Invoke onAnimationComplete immediately so tests relying on it work.
    React.useEffect(() => {
      if (typeof onAnimationComplete === 'function') {
        (onAnimationComplete as () => void)();
      }
    }, [onAnimationComplete]);

    // eslint-disable-next-line react-hooks/refs -- test mock: ref forwarding is intentional
    return React.createElement(target, { ...filtered, ref }, children as React.ReactNode);
  }) as unknown as React.FC<Record<string, unknown>>;
}

function getMotionComponent(tag: string): React.FC<Record<string, unknown>> {
  let comp = componentCache.get(tag);
  if (!comp) {
    comp = makeMotionComponent(tag);
    componentCache.set(tag, comp);
  }
  return comp;
}

/**
 * Mock for `motion.create(Component)` — wraps an arbitrary component, stripping
 * motion props. Callers invoke this once at module load, so no cache is needed.
 */
function createMotionComponent(Component: React.ElementType): React.FC<Record<string, unknown>> {
  return makeMotionComponent(Component);
}

// Global mock for motion/react — renders plain HTML elements without animation props.
// Eliminates the need to duplicate this mock in every component test file.
vi.mock('motion/react', () => ({
  motion: new Proxy(
    {},
    {
      get: (_target: unknown, prop: string) =>
        prop === 'create' ? createMotionComponent : getMotionComponent(prop),
    }
  ),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  LayoutGroup: ({ children }: { children: React.ReactNode }) => children,
  MotionConfig: ({ children }: { children: React.ReactNode }) => children,
  useReducedMotion: () => false,
  useAnimate: () => [{ current: document.createElement('div') }, vi.fn()],
  // Inert drag/animation controls: gesture and imperative-animation mechanics
  // are browser territory, not jsdom's.
  useDragControls: () => ({ start: vi.fn() }),
  useAnimationControls: () => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    set: vi.fn(),
  }),
  // A spring that has already arrived, and a transform read straight off it.
  // Same principle as `animate` below: a test reads the number a component
  // reports, never a frame of its way there. Because the mock re-reads its
  // argument on every render, a value that changes is simply the new value.
  useMotionValue: (value: unknown) => ({ get: () => value, set: () => {}, on: () => () => {} }),
  useSpring: (value: unknown) => ({ get: () => value, set: () => {}, on: () => () => {} }),
  useTransform: (source: { get: () => unknown }, transform: (latest: unknown) => unknown) =>
    transform(source.get()),
  // Imperative animate: settle to the target immediately so counted values show
  // their final state synchronously in tests.
  animate: (_from: unknown, to: unknown, opts?: { onUpdate?: (v: unknown) => void }) => {
    if (typeof opts?.onUpdate === 'function' && typeof to === 'number') opts.onUpdate(to);
    return { stop: () => {} };
  },
}));

/**
 * The virtualizer, stood in for everywhere.
 *
 * **jsdom has no layout, so a real one draws nothing at all.** TanStack Virtual
 * derives its visible window from the scroll element's `clientHeight`, which
 * jsdom reports as 0 for every element there has ever been — so
 * `getVirtualItems()` answers with an empty range and a mounted conversation
 * renders a correctly-sized empty box. Every assertion about what a list shows
 * would then be vacuous, and the ones that survived would be asserting the
 * absence of rows for the wrong reason.
 *
 * The stand-in draws every row at a fixed height. That is exactly the shape the
 * room's list had before `Conversation.Timeline` virtualized it, so the room and
 * chat suites test what they always tested: WHICH rows are drawn, in what order,
 * with what on them. Whether virtualization itself keeps a long channel smooth
 * is a browser question, and `apps/e2e` is where it is asked.
 *
 * Global rather than per-suite for the same reason `motion/react` is above: it
 * is a fact about the environment, not about any one test, and forty suites
 * repeating it would drift.
 */
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_unused, index) => ({
        key: `virtual-${index}`,
        index,
        start: index * 80,
        size: 80,
      })),
    getTotalSize: () => count * 80,
    measureElement: vi.fn(),
    scrollToEnd: vi.fn(),
    scrollToIndex: vi.fn(),
    scrollToOffset: vi.fn(),
    isAtEnd: () => true,
  }),
}));
