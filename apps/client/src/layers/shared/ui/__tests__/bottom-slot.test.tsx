/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { BottomSlotCandidate } from '../bottom-slot';
import { BottomSlot } from '../bottom-slot';

// `motion.div` renders as a plain div so the entrance/exit props are readable
// as attributes. `initial` is the one under test — jsdom measures every element
// as 0x0, so the animation itself cannot be observed here, only whether the
// component asked for one.
let reducedMotion = false;
let isMobile = false;
vi.mock('@/layers/shared/model', () => ({ useIsMobile: () => isMobile }));
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    // `motion.create(Component)` — needed because this mock SHADOWS the complete
    // one in `test-setup.ts`, and a partial shadow breaks the moment anything in
    // the import graph calls it at module scope (`gen-ui/ui/nodes/TableNode.tsx`
    // does). Identity is enough: nothing here renders the wrapped component.
    create: (Component: unknown) => Component,
    div: ({
      children,
      initial,
      transition,
      ...rest
    }: {
      children?: React.ReactNode;
      initial?: unknown;
      transition?: { duration?: number };
    } & Record<string, unknown>) => (
      <div
        data-initial={initial === false ? 'false' : 'animated'}
        // The transition drives BOTH directions, so this is how the exit's
        // duration is observable — jsdom cannot watch a height collapse.
        data-duration={String(transition?.duration ?? '')}
        {...rest}
      >
        {children}
      </div>
    ),
  },
  useReducedMotion: () => reducedMotion,
}));

/** A candidate that draws its own id, so which one won is readable. */
function candidate(id: string, show: boolean): BottomSlotCandidate {
  return { id, show, render: () => <span data-testid={`card-${id}`}>{id}</span> };
}

/** The slot container, which is always in the DOM. */
function slot(): HTMLElement {
  const el = document.querySelector('[data-slot="sidebar-bottom-slot"]');
  if (el === null) throw new Error('the bottom slot did not render its container');
  return el as HTMLElement;
}

afterEach(() => {
  cleanup();
  reducedMotion = false;
  isMobile = false;
});

describe('BottomSlot', () => {
  describe('one card at a time, by priority', () => {
    it('renders the first candidate whose show is true', () => {
      render(
        <BottomSlot
          candidates={[
            candidate('progress', false),
            candidate('update', true),
            candidate('promo', true),
          ]}
          ready
        />
      );
      expect(screen.getByTestId('card-update')).toBeTruthy();
      expect(screen.queryByTestId('card-promo')).toBeNull();
    });

    it('prefers the earlier candidate when several qualify', () => {
      // The order IS the decision: a blocked setup beats a version nudge beats a
      // profile nicety beats marketing. Catches a sort, a reverse, or a
      // `findLast`.
      render(
        <BottomSlot candidates={[candidate('progress', true), candidate('update', true)]} ready />
      );
      expect(screen.getByTestId('card-progress')).toBeTruthy();
      expect(screen.queryByTestId('card-update')).toBeNull();
    });

    it('falls through to the next candidate when the winner stops qualifying', () => {
      const { rerender } = render(
        <BottomSlot candidates={[candidate('progress', true), candidate('promo', true)]} ready />
      );
      expect(screen.getByTestId('card-progress')).toBeTruthy();

      rerender(
        <BottomSlot candidates={[candidate('progress', false), candidate('promo', true)]} ready />
      );
      expect(screen.getByTestId('card-promo')).toBeTruthy();
      expect(screen.queryByTestId('card-progress')).toBeNull();
    });

    it('draws nothing at all when no candidate qualifies', () => {
      render(<BottomSlot candidates={[candidate('promo', false)]} ready />);
      expect(slot().children.length).toBe(0);
    });

    it('never calls render on a candidate that did not win', () => {
      // Catches an arbiter that builds every card and hides the losers: these
      // are real components with real queries behind them.
      const loser = vi.fn(() => <span />);
      render(
        <BottomSlot
          candidates={[candidate('progress', true), { id: 'promo', show: true, render: loser }]}
          ready
        />
      );
      expect(loser).not.toHaveBeenCalled();
    });
  });

  describe('it paints with the panel, not before it', () => {
    it('draws nothing while the panel is not ready, however well a card qualifies', () => {
      // Spec `sidebar-simplification` D6 item 9. A browser test found a promo
      // card sitting under eight skeleton bones: the slot had its answer before
      // the panel had its rows, so the sidebar arrived in pieces, bottom first.
      // `ready` gates the card's PRESENCE, not only its entrance animation.
      //
      // Red when: the winner is picked without consulting `ready`.
      render(<BottomSlot candidates={[candidate('progress', true)]} ready={false} />);
      expect(screen.queryByTestId('card-progress')).toBeNull();
      expect(slot().children.length).toBe(0);
    });

    it('keeps its box either way, so nothing below it moves when the card lands', () => {
      // The container is always in the DOM (`empty:p-0`), so withholding the
      // card cannot be what shifts the footer.
      const { rerender } = render(
        <BottomSlot candidates={[candidate('progress', true)]} ready={false} />
      );
      expect(slot()).not.toBeNull();
      rerender(<BottomSlot candidates={[candidate('progress', true)]} ready />);
      expect(screen.getByTestId('card-progress')).toBeInTheDocument();
    });

    it('does not ask the card it was holding back for an entrance', () => {
      // The card was withheld, not "arriving later": it is what the panel came
      // up with, so it is simply there on the frame the panel is.
      const { rerender } = render(
        <BottomSlot candidates={[candidate('progress', true)]} ready={false} />
      );
      rerender(<BottomSlot candidates={[candidate('progress', true)]} ready />);

      expect(screen.getByTestId('card-progress').parentElement).toHaveAttribute(
        'data-initial',
        'false'
      );
    });
  });

  describe('the entrance never plays on boot', () => {
    it('does not animate a card that already qualifies when the facts land', () => {
      // Defect #9 in the load trace: the cards faded up in the footer at
      // different times, each shrinking the scroller. Every candidate is gated
      // on a server read, so "qualifies as soon as we know anything" is the
      // normal case and must be still.
      const { rerender } = render(
        <BottomSlot candidates={[candidate('progress', false)]} ready={false} />
      );
      rerender(<BottomSlot candidates={[candidate('progress', true)]} ready />);

      expect(screen.getByTestId('card-progress').parentElement).toHaveAttribute(
        'data-initial',
        'false'
      );
    });

    it('does not re-arm the entrance on the card boot already painted', () => {
      // The boot latch settles one render AFTER `ready`. A boolean latch would
      // flip then and ask the card already on screen for an entrance — invisible
      // with the real library, which reads `initial` only at mount, but only by
      // accident. Catches a latch that is not keyed to the winner.
      const { rerender } = render(
        <BottomSlot candidates={[candidate('progress', false)]} ready={false} />
      );
      rerender(<BottomSlot candidates={[candidate('progress', true)]} ready />);
      rerender(<BottomSlot candidates={[candidate('progress', true)]} ready />);

      expect(screen.getByTestId('card-progress').parentElement).toHaveAttribute(
        'data-initial',
        'false'
      );
    });

    it('animates a card that qualifies later, after the facts have landed', () => {
      // The other half — without it, "never animate" would pass by never
      // animating anything, and an update that arrives mid-session would appear
      // with a jump.
      const { rerender } = render(<BottomSlot candidates={[candidate('update', false)]} ready />);
      rerender(<BottomSlot candidates={[candidate('update', false)]} ready />);
      rerender(<BottomSlot candidates={[candidate('update', true)]} ready />);

      expect(screen.getByTestId('card-update').parentElement).toHaveAttribute(
        'data-initial',
        'animated'
      );
    });

    it('is instant under reduced motion, even after boot', () => {
      reducedMotion = true;
      const { rerender } = render(<BottomSlot candidates={[candidate('update', false)]} ready />);
      rerender(<BottomSlot candidates={[candidate('update', false)]} ready />);
      rerender(<BottomSlot candidates={[candidate('update', true)]} ready />);

      const card = screen.getByTestId('card-update').parentElement;
      expect(card).toHaveAttribute('data-initial', 'false');
      // The EXIT too: reduced motion means instant in both directions, so the
      // card collapsing after a dismissal does not animate either. Catches a
      // transition that gates only the entrance on the preference.
      expect(card).toHaveAttribute('data-duration', '0');
    });

    it('animates the exit at full duration when motion is allowed', () => {
      // The control for the case above — without it, "instant under reduced
      // motion" would pass on a component that never animates anything.
      const { rerender } = render(<BottomSlot candidates={[candidate('update', false)]} ready />);
      rerender(<BottomSlot candidates={[candidate('update', true)]} ready />);

      expect(screen.getByTestId('card-update').parentElement).toHaveAttribute(
        'data-duration',
        '0.16'
      );
    });
  });

  describe('the thumb floor on a phone', () => {
    it('gives every control in a bottom card a 44px minimum on a coarse pointer', () => {
      // The slot puts pointer-sized cards on a phone for the first time — the
      // cockpit sidebar is replaced wholesale by the mobile tabs — and
      // `mobile-touch.spec.ts` swept the promo card's dismiss at 18.99px
      // against its 40px bar. Only a browser can measure the pixels; this pins
      // the class that produces them, at the ONE seam every card passes
      // through, so the next card cannot arrive without it.
      isMobile = true;
      render(<BottomSlot candidates={[candidate('promo', true)]} ready />);

      expect(slot().className).toContain('[&_button]:min-h-11');
    });

    it('leaves a pointer alone — a 44px dismiss on a desktop panel is a smudge', () => {
      render(<BottomSlot candidates={[candidate('promo', true)]} ready />);

      expect(slot().className).not.toContain('[&_button]:min-h-11');
    });
  });

  it('keeps its container in the DOM so the panel can pin it', () => {
    // The container is what `DashboardSidebar` places between the scroller and
    // the footer. If it only existed while a card qualified, the slot's position
    // would be untestable and the panel's layout would depend on whether there
    // happened to be anything to say.
    render(<BottomSlot candidates={[candidate('promo', false)]} ready />);
    expect(slot().className).toContain('shrink-0');
  });
});
