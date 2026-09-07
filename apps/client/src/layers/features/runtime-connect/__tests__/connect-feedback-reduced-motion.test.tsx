/**
 * @vitest-environment jsdom
 *
 * The spinner actually stops for a reader who asked for less motion.
 *
 * `Spinner` spins unconditionally — `animate-spin` is its cva base — so the
 * five call sites that hold still have to turn it OFF at the call site, and the
 * only thing that displaces a base class through `cn` is `tailwind-merge`
 * resolving the two members of the `animate` group. That is two mechanisms
 * deep, and a source-level grep can see neither of them: it cannot tell whether
 * the gate is the right way round without being told, and it cannot tell
 * whether `animate-spin` actually left the rendered element (DOR-1811).
 *
 * So this renders. `ConnectProgressRow` is the smallest of the five sites — no
 * providers, no stores — and it wears the same expression the other three
 * JS-gated sites do, so what holds here holds for them.
 *
 * Its own file because of how it has to be built: `test-setup.ts` mocks
 * `motion/react` globally with a plain `useReducedMotion: () => false`, not a
 * spy, so the only way to make it answer `true` is a file-level `vi.mock` that
 * replaces the global one outright — the same reason
 * `TeamRosterGrid.reduced-motion.test.tsx` lives apart from its siblings.
 *
 * @module features/runtime-connect/__tests__/connect-feedback-reduced-motion
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement, type ElementType, type ReactNode } from 'react';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

/** Motion props that must never reach the DOM as attributes. */
const MOTION_PROPS = new Set([
  'layout',
  'layoutId',
  'initial',
  'animate',
  'exit',
  'transition',
  'variants',
  'whileHover',
  'whileTap',
]);

/** Flipped per case. `vi.hoisted` so the mock factory below can close over it. */
const preference = vi.hoisted(() => ({ reduced: false }));

vi.mock('motion/react', () => ({
  motion: new Proxy(
    {},
    {
      get: (_target: unknown, tag: string) => {
        if (tag === 'create') return (Component: ElementType) => Component;
        return (allProps: Record<string, unknown>) => {
          const { children, ...rest } = allProps;
          const filtered = Object.fromEntries(
            Object.entries(rest).filter(([key]) => !MOTION_PROPS.has(key))
          );
          return createElement(tag, filtered, children as ReactNode);
        };
      },
    }
  ),
  AnimatePresence: ({ children }: { children?: ReactNode }) => children,
  LayoutGroup: ({ children }: { children?: ReactNode }) => children,
  useReducedMotion: () => preference.reduced,
}));

const { ConnectProgressRow } = await import('../ui/connect-feedback');
const { Spinner } = await import('@/layers/shared/ui');

afterEach(() => {
  cleanup();
  preference.reduced = false;
});

/** The spinner inside the progress row, by the slot the component stamps. */
function spinner(container: HTMLElement): Element {
  const found = container.querySelector('[data-slot="spinner"]');
  expect(found, 'the progress row drew no spinner at all').not.toBeNull();
  return found!;
}

describe('the connect progress spinner and the reduced-motion preference', () => {
  it('spins for a reader who did not ask for less motion', () => {
    preference.reduced = false;
    const { container } = render(<ConnectProgressRow message="Reaching Ollama…" />);
    expect(spinner(container)).toHaveClass('animate-spin');
    expect(spinner(container)).not.toHaveClass('animate-none');
  });

  it('stops for a reader who did', () => {
    // The half that matters, and the half an inverted gate breaks: with
    // `!reducedMotion && 'animate-none'` this case still carries
    // `animate-spin` and fails here, which a source-level grep could not see.
    preference.reduced = true;
    const { container } = render(<ConnectProgressRow message="Reaching Ollama…" />);
    expect(spinner(container)).toHaveClass('animate-none');
    expect(spinner(container)).not.toHaveClass('animate-spin');
  });

  it('lets the CSS spelling of the same gate survive the class merge', () => {
    // `PendingRow` gates on the `motion-reduce:` variant instead of the hook,
    // which no jsdom render can evaluate — the media query is the whole
    // mechanism. What IS assertable, and what would silently break the site,
    // is `tailwind-merge` dropping the variant on its way through `cn`: both
    // classes belong to the `animate` group and only the differing modifier
    // keeps them from colliding.
    const { container } = render(<Spinner size="xs" className="motion-reduce:animate-none" />);
    const glyph = spinner(container);
    expect(glyph).toHaveClass('animate-spin');
    expect(glyph).toHaveClass('motion-reduce:animate-none');
  });
});
