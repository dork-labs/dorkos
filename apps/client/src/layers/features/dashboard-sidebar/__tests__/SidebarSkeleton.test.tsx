/**
 * The boot skeleton, and the one reveal's numbers (spec `sidebar-simplification` D6).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SIDEBAR_ROW_INSET } from '@/layers/shared/ui';
import { SidebarSkeleton } from '../ui/boot/SidebarSkeleton';
import {
  REVEAL_RISE_PX,
  REVEAL_SECONDS,
  REVEAL_STAGGER_SECONDS,
  revealTransition,
} from '../ui/boot/sidebar-reveal';

afterEach(cleanup);

describe('SidebarSkeleton — reserving the panel', () => {
  it('draws three header bones and eight row bones', () => {
    // The count is the reservation. Fewer bones than the panel has rows and the
    // scroller grows when the real rows land, which is the layout shift the
    // skeleton exists to prevent.
    const { container } = render(<SidebarSkeleton />);
    expect(container.querySelectorAll('[data-slot="sidebar-menu-skeleton"]')).toHaveLength(8);
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(
      // Eight rows contribute a glyph bone and a label bone each; three headers
      // contribute one apiece.
      8 * 2 + 3
    );
  });

  it('puts every row bone on the row’s own geometry', () => {
    // jsdom measures nothing, so the classes ARE the assertion — the same way
    // the row's own gutter test pins its declaration. Red when a bone stops
    // reading `--sidebar-row-x` and the label bones start on a different x from
    // the labels they stand in for.
    const { container } = render(<SidebarSkeleton />);
    const bone = container.querySelector('[data-slot="sidebar-menu-skeleton"]');
    expect(bone).not.toBeNull();
    for (const cls of SIDEBAR_ROW_INSET.split(' ')) {
      expect(bone!.className).toContain(cls);
    }
    expect(bone!.className).toContain('min-h-7');
  });

  it('starts every header bone at --sidebar-header-x', () => {
    const { container } = render(<SidebarSkeleton />);
    const headers = [...container.querySelectorAll('div')].filter((node) =>
      node.className.includes('--sidebar-header-x')
    );
    expect(headers).toHaveLength(3);
  });

  it('says nothing to a screen reader', () => {
    // `aria-busy` on the panel's nav is the whole announcement; bones read out
    // as a list of nothing would be noise about nothing.
    render(<SidebarSkeleton />);
    expect(screen.getByTestId('sidebar-skeleton')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('the one reveal', () => {
  it('is instant under a reduced-motion preference', () => {
    // Not "quick" — zero. The reveal carries no information the panel does not
    // already carry, so there is nothing to shorten rather than remove.
    expect(revealTransition(true).duration).toBe(0);
  });

  it('takes 160 ms otherwise, including before the preference is known', () => {
    expect(revealTransition(false).duration).toBe(REVEAL_SECONDS);
    expect(revealTransition(null).duration).toBe(REVEAL_SECONDS);
    expect(REVEAL_SECONDS).toBe(0.16);
  });

  it('staggers zones by 30 ms and rises 4 px', () => {
    // Per zone, never per row: a thirty-row panel staggered by row takes most
    // of a second to finish arriving.
    expect(REVEAL_STAGGER_SECONDS).toBe(0.03);
    expect(REVEAL_RISE_PX).toBe(4);
  });
});
