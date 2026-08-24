/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MarketingNav } from '../MarketingNav';
import { NAV_LINKS } from '../../lib/nav-links';

const mockPathname = vi.hoisted(() => ({ value: '/' }));

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname.value,
}));

/** The pill only yields on a page tall enough to scroll through. */
function makePageScrollable(height = 10_000) {
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    value: height,
    configurable: true,
  });
}

function scrollTo(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true, writable: true });
  act(() => {
    window.dispatchEvent(new Event('scroll'));
    // The handler is throttled at 150ms; let the trailing edge land.
    vi.advanceTimersByTime(200);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockPathname.value = '/';
  makePageScrollable();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MarketingNav destinations', () => {
  it('renders every destination, Compare included', () => {
    render(<MarketingNav links={NAV_LINKS} />);

    const compare = screen.getByRole('link', { name: 'compare' });
    expect(compare.getAttribute('href')).toBe('/compare');
    expect(screen.getAllByRole('link')).toHaveLength(NAV_LINKS.length);
  });
});

describe('MarketingNav active section', () => {
  it('marks the section you are reading as the current page', () => {
    mockPathname.value = '/compare/cursor';
    render(<MarketingNav links={NAV_LINKS} />);

    expect(screen.getByRole('link', { name: 'compare' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'features' }).hasAttribute('aria-current')).toBe(false);
  });

  it('marks the section index too', () => {
    mockPathname.value = '/compare';
    render(<MarketingNav links={NAV_LINKS} />);

    expect(screen.getByRole('link', { name: 'compare' }).getAttribute('aria-current')).toBe('page');
  });

  it('marks home only on the homepage', () => {
    mockPathname.value = '/compare';
    render(<MarketingNav links={NAV_LINKS} />);

    expect(screen.getByRole('link', { name: 'home' }).hasAttribute('aria-current')).toBe(false);
  });
});

describe('MarketingNav yielding to content', () => {
  // The pill floats over the page. jsdom has no layout, so overlap itself is
  // measured in the browser (see the scroll probe in DOR-1504); what is
  // asserted here is the behavior that makes the fix work — while you read
  // downward the pill stops taking clicks and leaves the tab order.
  it('steps aside once you are reading down the page', () => {
    render(<MarketingNav links={NAV_LINKS} />);
    const nav = screen.getByRole('navigation', { name: 'Site sections' });

    expect(nav.hasAttribute('inert')).toBe(false);

    scrollTo(1200);

    expect(nav.hasAttribute('inert')).toBe(true);
    expect(nav.className).toContain('pointer-events-none');
  });

  it('comes back the moment you scroll up', () => {
    render(<MarketingNav links={NAV_LINKS} />);
    const nav = screen.getByRole('navigation', { name: 'Site sections' });

    scrollTo(1200);
    expect(nav.hasAttribute('inert')).toBe(true);

    scrollTo(900);

    expect(nav.hasAttribute('inert')).toBe(false);
  });

  it('stays put near the top of the page', () => {
    render(<MarketingNav links={NAV_LINKS} />);
    const nav = screen.getByRole('navigation', { name: 'Site sections' });

    scrollTo(120);

    expect(nav.hasAttribute('inert')).toBe(false);
  });

  it('is waiting at the end of the page', () => {
    render(<MarketingNav links={NAV_LINKS} />);
    const nav = screen.getByRole('navigation', { name: 'Site sections' });

    scrollTo(1200);
    expect(nav.hasAttribute('inert')).toBe(true);

    // Scrolling down onto the last screen — still downward, but arrived.
    scrollTo(10_000 - window.innerHeight);

    expect(nav.hasAttribute('inert')).toBe(false);
  });
});
