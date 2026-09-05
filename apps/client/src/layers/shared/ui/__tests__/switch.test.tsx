/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  Switch,
  switchVariants,
  SWITCH_TRACKS,
  SWITCH_RESPONSIVE_TRACKS,
  type SwitchSize,
} from '../switch';

afterEach(cleanup);

/** The thumb Radix renders inside a switch root. */
function thumbOf(root: HTMLElement): HTMLElement {
  const thumb = root.querySelector<HTMLElement>('[data-slot="switch-thumb"]');
  if (!thumb) throw new Error('switch rendered no thumb');
  return thumb;
}

describe('Switch', () => {
  // The whole reason this primitive moved to `tv` slots: a track width and the
  // travel that crosses it are one decision, and they used to live in two
  // tables. Travel = track − thumb − 2px of border, at every size.
  it.each([
    ['sm', 'w-7', 'w-3', 'data-[state=checked]:translate-x-3'],
    ['md', 'w-9', 'w-4', 'data-[state=checked]:translate-x-4'],
    ['lg', 'w-11', 'w-5', 'data-[state=checked]:translate-x-5'],
    ['xl', 'w-14', 'w-6', 'data-[state=checked]:translate-x-7'],
  ] as const)('sizes the track and its thumb together at %s', (size, track, thumb, travel) => {
    render(<Switch size={size} responsive={false} aria-label={size} />);
    const root = screen.getByRole('switch');
    expect(root).toHaveClass(track);
    expect(thumbOf(root)).toHaveClass(thumb, travel);
  });

  // Responsive is mobile-first and must REPLACE the chosen size's fixed height,
  // not sit beside it — tailwind-merge is what makes the second axis safe.
  it('gives an unsized switch the mobile-first ladder and no fixed height', () => {
    render(<Switch aria-label="Responsive" />);
    const root = screen.getByRole('switch');
    expect(root).toHaveClass('h-8', 'w-14', 'sm:h-6', 'sm:w-11', 'md:h-5', 'md:w-9');
    expect(root).not.toHaveClass('h-5');
    expect(thumbOf(root)).toHaveClass('h-6', 'md:h-4', 'md:data-[state=checked]:translate-x-4');
  });

  // The bug this pins: `responsive` used to be dropped the moment a size was
  // given, so `<Switch size="sm" responsive />` rendered a 16px switch on a
  // phone and nothing said why.
  it('climbs the ladder from an explicit size instead of ignoring the prop', () => {
    render(<Switch size="sm" aria-label="Small" />);
    const root = screen.getByRole('switch');
    expect(root).toHaveClass('h-6', 'w-11', 'sm:h-5', 'sm:w-9', 'md:h-4', 'md:w-7');
  });

  // `xl` is the top of the ladder, so there is nothing above it to grow into.
  it('stops climbing at the largest size', () => {
    render(<Switch size="xl" aria-label="Largest" />);
    expect(screen.getByRole('switch')).toHaveClass('h-8', 'w-14', 'sm:h-8', 'md:h-8');
  });

  it('opts out of the ladder entirely when asked', () => {
    render(<Switch size="sm" responsive={false} aria-label="Fixed" />);
    const root = screen.getByRole('switch');
    expect(root).toHaveClass('h-4', 'w-7');
    expect(root.className).not.toContain('sm:');
  });

  it('lets the caller add classes on the root', () => {
    render(<Switch className="ml-auto" aria-label="Nudged" />);
    expect(screen.getByRole('switch')).toHaveClass('ml-auto');
  });

  it('exports its variants for callers that need the recipe', () => {
    expect(switchVariants({ size: 'xl' }).root()).toContain('w-14');
  });
});

// `SWITCH_RESPONSIVE_TRACKS` is written out rather than built, because Tailwind
// only sees class names that appear literally in a source file — a `'md:' + x`
// assembled at runtime is a class the CSS never contains, and the switch would
// keep its phone size on a desktop with nothing red anywhere. The cost of that
// literal table is drift, and this is what stops it.
describe('the responsive ladder matches the size table it climbs', () => {
  const ORDER = ['sm', 'md', 'lg', 'xl'] as const;

  /** The size `steps` rungs above this one, stopping at the top of the ladder. */
  function stepUp(size: SwitchSize, steps: number): SwitchSize {
    return ORDER[Math.min(ORDER.indexOf(size) + steps, ORDER.length - 1)];
  }

  /** The same classes, each behind a breakpoint prefix. */
  function at(prefix: 'sm' | 'md', classes: string): string {
    return classes
      .split(' ')
      .map((className) => `${prefix}:${className}`)
      .join(' ');
  }

  it.each(ORDER)('derives %s from SWITCH_TRACKS', (size) => {
    for (const slot of ['root', 'thumb'] as const) {
      const expected = [
        SWITCH_TRACKS[stepUp(size, 2)][slot],
        at('sm', SWITCH_TRACKS[stepUp(size, 1)][slot]),
        at('md', SWITCH_TRACKS[size][slot]),
      ].join(' ');
      expect(SWITCH_RESPONSIVE_TRACKS[size][slot]).toBe(expected);
    }
  });
});
