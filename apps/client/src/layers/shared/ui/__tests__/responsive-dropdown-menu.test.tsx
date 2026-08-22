// @vitest-environment jsdom
/**
 * The responsive menu renders two entirely different trees — a Radix dropdown on
 * desktop, a drawer on mobile — from one set of props. Anything a caller passes
 * has to survive BOTH branches, and a prop that is only forwarded on one is
 * invisible in the branch that drops it.
 *
 * These cases exercise the REAL primitive. The status bar's own test renders a
 * hand-taught stand-in for the menu (to escape portals and floating-ui), which
 * can only ever certify the stand-in: teach it to forward a prop and the test
 * passes whether or not the shipping component does.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mockUseIsMobile = vi.fn(() => false);
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useIsMobile: () => mockUseIsMobile() };
});

import {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
  ResponsiveDropdownMenuTrigger,
} from '../responsive-dropdown-menu';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

beforeEach(() => mockUseIsMobile.mockReturnValue(false));
afterEach(cleanup);

/** A radio group described by a note beside it — the status bar's account picker in miniature. */
function DescribedGroup() {
  return (
    <ResponsiveDropdownMenu open>
      <ResponsiveDropdownMenuTrigger>open</ResponsiveDropdownMenuTrigger>
      <ResponsiveDropdownMenuContent>
        <p id="scope-note">This session only.</p>
        <ResponsiveDropdownMenuRadioGroup value="a" aria-describedby="scope-note">
          <ResponsiveDropdownMenuRadioItem value="a">A</ResponsiveDropdownMenuRadioItem>
        </ResponsiveDropdownMenuRadioGroup>
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
}

/**
 * The grouping element, whichever role this branch gives it: Radix's menu
 * renders `role="group"` (its items are `menuitemradio`), while the drawer
 * renders a plain `radiogroup`. Asked for by role rather than a test id so the
 * assertion is about what assistive tech actually reaches.
 */
function groupElement(): HTMLElement {
  return screen.queryByRole('radiogroup') ?? screen.getByRole('group');
}

describe('ResponsiveDropdownMenuRadioGroup — aria-describedby', () => {
  it('carries the description on desktop (the Radix dropdown branch)', () => {
    render(<DescribedGroup />);
    expect(groupElement()).toHaveAccessibleDescription('This session only.');
  });

  it('carries it on mobile too (the drawer branch, a different tree entirely)', () => {
    // The branch a desktop-only assertion silently misses. Same props, same
    // promise — a caveat that exists only on one form factor is not a caveat.
    mockUseIsMobile.mockReturnValue(true);
    render(<DescribedGroup />);
    expect(groupElement()).toHaveAccessibleDescription('This session only.');
  });
});
