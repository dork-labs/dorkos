/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
});
