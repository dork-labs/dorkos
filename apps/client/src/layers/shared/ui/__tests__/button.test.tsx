/**
 * @vitest-environment jsdom
 *
 * Touch targets for the responsive-scaling sizes (DOR-771). Apple HIG asks for
 * 44pt, Material for 48dp; `size="sm"` used to give 40px on touch — the ruler
 * that measures this for real is `apps/e2e/tests/rooms/room-sheet-helpers.ts`'s
 * `TOUCH_TARGET_PX = 44`, but the class that decides the height is asserted
 * here so a future regression fails fast, in milliseconds, without a browser.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Button } from '../button';

afterEach(cleanup);

describe('Button responsive touch-target height', () => {
  it('gives size="sm" a 44px touch height, not 40px', () => {
    const { getByRole } = render(<Button size="sm">Try again</Button>);
    // Tailwind's h-11 is 2.75rem (44px); h-10 (40px) is the class this test
    // used to see before the fix, and must never come back.
    expect(getByRole('button').className).toContain('h-11');
    expect(getByRole('button').className).not.toContain('h-10 ');
  });

  it('keeps the desktop height at 32px — only the touch floor moved', () => {
    const { getByRole } = render(<Button size="sm">Try again</Button>);
    expect(getByRole('button').className).toContain('md:h-8');
  });

  it('leaves size="default" at its existing 44px touch height', () => {
    // Not the ticket's bug, but the same ruler — a regression here would be
    // just as real a touch-target failure.
    const { getByRole } = render(<Button size="default">Save</Button>);
    expect(getByRole('button').className).toContain('h-11');
  });

  it('does not touch the fixed xs and icon-xs sizes, which opt out of responsive scaling', () => {
    // These are deliberately small UI chrome (button.tsx's own comment), not
    // reachable touch targets in a busy toolbar — out of scope for DOR-771.
    const { getByRole } = render(<Button size="xs">•</Button>);
    expect(getByRole('button').className).not.toContain('h-11');
  });
});
