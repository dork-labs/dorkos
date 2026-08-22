// @vitest-environment jsdom
/**
 * Where a sidebar row's continuity motion lands (spec `sidebar-simplification`
 * D5).
 *
 * **The element matters more than the values here.** A FLIP measures the box
 * that moved, so the motion has to be on the `<li>` itself — a wrapper inside it
 * travels WITH the row and measures nothing. The values are settled in
 * `features/dashboard-sidebar/ui/motion/__tests__/sidebar-motion.test.ts`; this
 * file settles that the row puts them somewhere they can work, and that the
 * arrival tint is a pulse rather than a state.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SidebarRow } from '../sidebar-row';

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

afterEach(() => cleanup());

/** The list item a row drew — the element every one of these claims is about. */
function item(): HTMLElement {
  const row = screen.getByRole('button', { name: /Sweep the logs/ });
  const li = row.closest('li');
  expect(li).not.toBeNull();
  return li as HTMLElement;
}

describe('a sidebar row’s motion', () => {
  it('stamps the arrival on the list item, not on anything inside it', () => {
    render(<SidebarRow title="Sweep the logs" rowMotion={{ layout: true, arrived: true }} />);
    // The FLIP and the tint have to share one element or the tint will restart
    // every time the row moves.
    expect(item()).toHaveAttribute('data-arrived');
  });

  it('leaves the attribute off a row that was already there', () => {
    // Red if `arrived` is ever stamped as `data-arrived="false"`: the CSS
    // keyframe fires on the attribute EXISTING, so a false would tint every row
    // in Today on every rebuild.
    render(<SidebarRow title="Sweep the logs" rowMotion={{ layout: true, arrived: false }} />);
    expect(item()).not.toHaveAttribute('data-arrived');
  });

  it('carries the one-shot tint class only where motion is allowed', () => {
    render(<SidebarRow title="Sweep the logs" rowMotion={{ layout: true, arrived: true }} />);
    // `motion-safe:` and not a bare class: a reduced-motion preference gets no
    // flash rather than a shorter one.
    expect(item().className).toContain('motion-safe:data-arrived:animate-sidebar-row-arrived');
  });

  it('draws a plain list item for a row that was handed no motion', () => {
    // Every row outside the sidebar panel — and every row in it before this
    // landed — pays nothing: no motion component in the tree at all.
    render(<SidebarRow title="Sweep the logs" />);
    expect(item()).not.toHaveAttribute('data-arrived');
    expect(item().className).not.toContain('animate-sidebar-row-arrived');
  });
});
