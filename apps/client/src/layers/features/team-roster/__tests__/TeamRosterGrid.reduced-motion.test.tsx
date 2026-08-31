/**
 * @vitest-environment jsdom
 *
 * The roster under `prefers-reduced-motion: reduce`.
 *
 * Its own file because of how it has to be built. `test-setup.ts` mocks
 * `motion/react` globally with `useReducedMotion: () => false`, and that is a
 * plain function rather than a spy, so there is no way to make it answer `true`
 * from inside a test. A file-level `vi.mock` replaces the global one outright,
 * which is why this lives apart from `TeamRosterGrid.flip.test.tsx` rather than
 * as one more case in it.
 *
 * The reason this is worth a file at all: the global reduced-motion reset in
 * `index.css` collapses CSS transition and animation durations, and `motion`
 * never goes through CSS — it writes inline styles from JS. So this is the one
 * gate in the whole identity grammar that reduced motion does *not* get for
 * free, and the only one that can silently keep animating after someone asks it
 * not to.
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

vi.mock('motion/react', () => ({
  motion: new Proxy(
    {},
    {
      get: (_target: unknown, tag: string) => {
        // `motion.create(Component)` wraps a component, unlike every other
        // property here which is a tag name — a shadow that did not
        // special-case this would treat "create" as the tag and hand back a
        // broken <create> element instead of the caller's component (DOR-1416).
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
  // The whole point of this file.
  useReducedMotion: () => true,
}));

const { MOCK_TEAM_ROSTER } = await import('@/dev/mock-samples');
const { TeamRosterGrid } = await import('../ui/TeamRosterGrid');

afterEach(cleanup);

describe('the roster under reduced motion', () => {
  it('does not animate layout, however small the roster is', () => {
    // Three cards is comfortably inside the size gate, so a `false` here can
    // only have come from the preference — which is what makes this
    // discriminating rather than a second reading of the count test.
    const members = MOCK_TEAM_ROSTER.slice(0, 3);
    render(<TeamRosterGrid members={members} roster={MOCK_TEAM_ROSTER} grouped={false} />);

    expect(document.querySelector('[data-slot="team-roster-grid"]')).toHaveAttribute(
      'data-layout-animated',
      'false'
    );
  });

  it('tells the cards not to animate either', () => {
    const members = MOCK_TEAM_ROSTER.slice(0, 3);
    render(<TeamRosterGrid members={members} roster={MOCK_TEAM_ROSTER} grouped={false} />);

    for (const card of document.querySelectorAll('[data-slot="team-member-card"]')) {
      expect(card).toHaveAttribute('data-layout-animated', 'false');
    }
  });

  it('still draws every card — the motion goes, the roster does not', () => {
    // "Keep the fact, drop the motion" is the repo's canonical reduced-motion
    // shape. A gate that hid rows would be dropping the fact as well.
    const members = MOCK_TEAM_ROSTER.slice(0, 3);
    render(<TeamRosterGrid members={members} roster={MOCK_TEAM_ROSTER} grouped={false} />);

    expect(document.querySelectorAll('[data-slot="team-member-card"]')).toHaveLength(3);
  });
});
