/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { TocSidebar } from '../TocSidebar';
import type { PlaygroundSection } from '../playground-registry';

// useTocScrollspy uses IntersectionObserver — stub it out
class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(public callback: IntersectionObserverCallback) {}
}

const MOCK_SECTIONS: PlaygroundSection[] = [
  {
    id: 'section-one',
    title: 'Section One',
    page: 'tokens',
    category: 'Colors',
    keywords: ['one'],
  },
  {
    id: 'section-two',
    title: 'Section Two',
    page: 'tokens',
    category: 'Layout',
    keywords: ['two'],
  },
  {
    id: 'section-three',
    title: 'Section Three',
    page: 'tokens',
    category: 'Shape',
    keywords: ['three'],
  },
];

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TocSidebar', () => {
  it('renders an aside with accessible label', () => {
    render(<TocSidebar sections={MOCK_SECTIONS} />);
    expect(screen.getByRole('complementary', { name: 'Table of contents' })).toBeInTheDocument();
  });

  it('renders "On this page" heading text', () => {
    render(<TocSidebar sections={MOCK_SECTIONS} />);
    expect(screen.getByText('On this page')).toBeInTheDocument();
  });

  it('renders a link for every section', () => {
    render(<TocSidebar sections={MOCK_SECTIONS} />);
    for (const section of MOCK_SECTIONS) {
      expect(screen.getByRole('link', { name: section.title })).toBeInTheDocument();
    }
  });

  it('each link href points to the section anchor', () => {
    render(<TocSidebar sections={MOCK_SECTIONS} />);
    for (const section of MOCK_SECTIONS) {
      const link = screen.getByRole('link', { name: section.title });
      expect(link).toHaveAttribute('href', `#${section.id}`);
    }
  });

  it('renders with empty sections without crashing', () => {
    render(<TocSidebar sections={[]} />);
    expect(screen.getByRole('complementary', { name: 'Table of contents' })).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('applies active styles to the currently intersecting section', () => {
    let capturedCallback: IntersectionObserverCallback | null = null;

    class TrackingObserver {
      observe = vi.fn((el: Element) => {
        // Simulate section-one becoming visible immediately on observe
        if (el.id === 'section-one' && capturedCallback) {
          capturedCallback(
            [{ target: el, isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver
          );
        }
      });
      unobserve = vi.fn();
      disconnect = vi.fn();
      constructor(cb: IntersectionObserverCallback) {
        capturedCallback = cb;
      }
    }

    vi.stubGlobal('IntersectionObserver', TrackingObserver);

    // Mount DOM anchor targets so getElementById finds them
    const anchor = document.createElement('section');
    anchor.id = 'section-one';
    document.body.appendChild(anchor);

    render(<TocSidebar sections={MOCK_SECTIONS} />);

    const activeLink = screen.getByRole('link', { name: 'Section One' });
    expect(activeLink).toHaveClass('bg-accent');

    document.body.removeChild(anchor);
  });

  it('applies inactive styles to non-active sections', () => {
    render(<TocSidebar sections={MOCK_SECTIONS} />);
    // No sections intersecting — all links should carry the muted style
    for (const section of MOCK_SECTIONS) {
      const link = screen.getByRole('link', { name: section.title });
      expect(link).toHaveClass('text-muted-foreground');
    }
  });

  it('renders a sub-heading for every distinct category (DOR-1766)', () => {
    render(<TocSidebar sections={MOCK_SECTIONS} />);
    for (const category of ['Colors', 'Layout', 'Shape']) {
      expect(screen.getByText(category)).toBeInTheDocument();
    }
  });

  it('folds consecutive same-category sections under one shared sub-heading', () => {
    const grouped: PlaygroundSection[] = [
      { id: 'a', title: 'A', page: 'tokens', category: 'Colors', keywords: ['a'] },
      { id: 'b', title: 'B', page: 'tokens', category: 'Colors', keywords: ['b'] },
      { id: 'c', title: 'C', page: 'tokens', category: 'Layout', keywords: ['c'] },
    ];
    render(<TocSidebar sections={grouped} />);
    // One "Colors" sub-heading, not one per section it covers.
    expect(screen.getAllByText('Colors')).toHaveLength(1);
    expect(screen.getAllByText('Layout')).toHaveLength(1);
  });

  it('merges non-consecutive occurrences of the same category under one heading', () => {
    // Non-consecutive runs are a real page shape (batch 20 audit finding I2,
    // DOR-1766) — six pages split a category across non-adjacent positions.
    // Grouping is keyed by name, not position, so this still renders one
    // "Colors" heading rather than showing it twice.
    const nonConsecutive: PlaygroundSection[] = [
      { id: 'a', title: 'A', page: 'tokens', category: 'Colors', keywords: ['a'] },
      { id: 'b', title: 'B', page: 'tokens', category: 'Layout', keywords: ['b'] },
      { id: 'c', title: 'C', page: 'tokens', category: 'Colors', keywords: ['c'] },
    ];
    render(<TocSidebar sections={nonConsecutive} />);
    expect(screen.getAllByText('Colors')).toHaveLength(1);
    // Both Colors sections still get their links, grouped together.
    expect(screen.getByRole('link', { name: 'A' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'C' })).toBeInTheDocument();
  });

  it('associates each heading with its section list via aria-labelledby', () => {
    render(<TocSidebar sections={MOCK_SECTIONS} />);
    const group = screen.getByRole('group', { name: 'Colors' });
    expect(within(group).getByRole('link', { name: 'Section One' })).toBeInTheDocument();
  });
});
