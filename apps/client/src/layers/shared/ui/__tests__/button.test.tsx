/**
 * @vitest-environment jsdom
 *
 * Touch targets for the responsive-scaling sizes (DOR-771). Apple HIG asks for
 * 44pt, Material for 48dp; `size="sm"` used to give 40px below the `md`
 * breakpoint — the ruler that measures this for real is
 * `apps/e2e/tests/rooms/room-sheet-helpers.ts`'s `TOUCH_TARGET_PX = 44`, but
 * the class that decides the height is asserted here so a future regression
 * fails fast, in milliseconds, without a browser. Note the gate is viewport
 * WIDTH (Tailwind's `md:`), not a touch-capability query — see the comment on
 * `RESPONSIVE_SIZE_CLASSES` in `button.tsx`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Button } from '../button';

afterEach(cleanup);

describe('Button responsive touch-target height', () => {
  it('gives size="sm" a 44px height below the md breakpoint, not 40px', () => {
    const { getByRole } = render(<Button size="sm">Try again</Button>);
    // Tailwind's h-11 is 2.75rem (44px); h-10 (40px) is the class this test
    // used to see before the fix, and must never come back.
    expect(getByRole('button').className).toContain('h-11');
    expect(getByRole('button').className).not.toContain('h-10 ');
  });

  it('keeps the height at 32px past the md breakpoint — only the narrow-screen floor moved', () => {
    const { getByRole } = render(<Button size="sm">Try again</Button>);
    expect(getByRole('button').className).toContain('md:h-8');
  });

  it('leaves size="md" at its existing 44px height below md', () => {
    // Not the ticket's bug, but the same ruler — a regression here would be
    // just as real a touch-target failure.
    const { getByRole } = render(<Button size="md">Save</Button>);
    expect(getByRole('button').className).toContain('h-11');
  });

  it('does not touch the fixed xs and icon-xs sizes, which opt out of responsive scaling', () => {
    // These are deliberately small UI chrome (button.tsx's own comment), not
    // reachable touch targets in a busy toolbar — out of scope for DOR-771.
    const { getByRole } = render(<Button size="xs">•</Button>);
    expect(getByRole('button').className).not.toContain('h-11');
  });
});

describe('Button press and disabled feedback', () => {
  it('answers a press with the 0.97 scale the design system asks every button for', () => {
    const { getByRole } = render(<Button>Save</Button>);
    expect(getByRole('button').className).toContain('motion-safe:active:scale-[0.97]');
  });

  it('gives every variant the same press — the primitive owns it, not the call site', () => {
    const { getByRole } = render(
      <Button variant="ghost" size="icon-sm" aria-label="More">
        •
      </Button>
    );
    expect(getByRole('button').className).toContain('motion-safe:active:scale-[0.97]');
  });

  it('names the properties it transitions, so the md: height swap is not animated', () => {
    // `transition-all` animated `height` too: dragging a window across 768px
    // re-ran RESPONSIVE_SIZE_CLASSES as an animation on every button on screen.
    const { getByRole } = render(<Button>Save</Button>);
    expect(getByRole('button').className).not.toContain('transition-all');
    expect(getByRole('button').className).toContain(
      'transition-[color,background-color,border-color,box-shadow,scale]'
    );
  });

  it('says "not allowed" when disabled, like Input and Checkbox do', () => {
    const { getByRole } = render(<Button disabled>Save</Button>);
    expect(getByRole('button').className).toContain('disabled:cursor-not-allowed');
  });
});

// An HTML <button> with no type is a SUBMIT button. Every `<Button onClick>`
// dropped inside a <form> therefore submitted it, and the bug presents as "the
// dialog closes when I click Cancel" — nowhere near the button.
describe('Button type', () => {
  it('defaults to type="button" so it cannot submit a form by accident', () => {
    const { getByRole } = render(<Button>Cancel</Button>);
    expect(getByRole('button')).toHaveAttribute('type', 'button');
  });

  it('still lets a caller mean type="submit"', () => {
    const { getByRole } = render(<Button type="submit">Save</Button>);
    expect(getByRole('button')).toHaveAttribute('type', 'submit');
  });

  it('leaves the element alone under asChild — the slotted child owns it', () => {
    const { getByRole } = render(
      <Button asChild>
        <a href="/team">Team</a>
      </Button>
    );
    expect(getByRole('link')).not.toHaveAttribute('type');
  });
});
