/**
 * @vitest-environment jsdom
 */
/**
 * The verb-ladder showcase shows the LADDER, not a drawing of it.
 *
 * `showcase-no-replicas.test.ts` catches a showcase that hand-copies markup by
 * reading its source. This catches the other half: a showcase that renders the
 * real components and yet shows nothing, because the store it depends on was
 * never seeded or the rungs stopped reaching the rows. Both failures are quiet
 * — the page still loads, and a reviewer scrolling past four blank panels reads
 * them as "nothing to see here".
 *
 * @module dev/__tests__/verb-ladder-showcase
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { VerbLadderShowcases } from '../showcases/VerbLadderShowcases';

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => cleanup());

describe('VerbLadderShowcases', () => {
  it('shows all four rungs, phrased by the real ladder', () => {
    render(<VerbLadderShowcases />);

    // Rung 1: the tool and what it is pointed at.
    expect(screen.getAllByText('Editing RoomRow.tsx…').length).toBeGreaterThan(0);
    // Rung 2: a live turn with no reading behind it.
    expect(screen.getByText('Working…')).toBeInTheDocument();
    // Rung 3: the one rung that is about the reader.
    expect(screen.getAllByText('waiting on you').length).toBeGreaterThan(0);
    // Rung 4 is silence, so it is proven by the absence of a second line on the
    // rows that carry it rather than by a string. (There are two: the rung
    // itself and the welcome-back demo built from the same idle session.)
    const idleRows = screen.getAllByRole('button', { name: /yesterday’s refactor/ });
    expect(idleRows.length).toBeGreaterThan(0);
    for (const idleRow of idleRows) {
      expect(idleRow.querySelector('[data-slot="sidebar-row-second-line"]')).toBeNull();
    }
  });

  it('draws the welcome-back beat through the real rule, not a hardcoded flag', () => {
    render(<VerbLadderShowcases />);
    const glowing = screen
      .getAllByRole('button', { name: /yesterday’s refactor/ })
      .filter((node) => node.className.includes('welcome-back-glow'));
    expect(glowing).toHaveLength(1);
  });

  it('puts the three dot signals in both themes, side by side (R1)', () => {
    const { container } = render(<VerbLadderShowcases />);
    // A `.light` island inside a dark page and a `.dark` island inside a light
    // one — the pair is what makes a both-themes review a single screenshot.
    expect(container.querySelector('.light')).not.toBeNull();
    expect(container.querySelector('.dark')).not.toBeNull();

    for (const theme of ['.light', '.dark']) {
      const panel = container.querySelector(theme);
      const statuses = [
        ...(panel?.querySelectorAll('[data-slot="identity-status-dot"]') ?? []),
      ].map((dot) => dot.getAttribute('data-status'));
      expect(statuses, theme).toEqual(['working', 'needs-you', 'error']);
    }
  });
});
