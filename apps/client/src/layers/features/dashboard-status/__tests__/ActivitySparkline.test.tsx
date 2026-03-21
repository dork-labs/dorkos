/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActivitySparkline } from '../ui/ActivitySparkline';

describe('ActivitySparkline', () => {
  it('renders SVG with 7 rect elements', () => {
    const { container } = render(<ActivitySparkline data={[0, 1, 2, 3, 4, 5, 6]} />);

    const rects = container.querySelectorAll('rect');
    expect(rects).toHaveLength(7);
  });

  it('renders all bars with minimum 1px height when data is all zeros', () => {
    const { container } = render(<ActivitySparkline data={[0, 0, 0, 0, 0, 0, 0]} />);

    const rects = container.querySelectorAll('rect');
    rects.forEach((rect) => {
      const height = parseFloat(rect.getAttribute('height') ?? '0');
      expect(height).toBeGreaterThanOrEqual(1);
    });
  });

  it('normalizes bar heights relative to max value', () => {
    const { container } = render(<ActivitySparkline data={[0, 0, 0, 0, 0, 0, 10]} />);

    const rects = container.querySelectorAll('rect');
    // Last bar (max value) should have height equal to full chart height (30)
    const lastRect = rects[6];
    const lastHeight = parseFloat(lastRect.getAttribute('height') ?? '0');
    expect(lastHeight).toBe(30);

    // First bar (0 value) should have minimum height
    const firstRect = rects[0];
    const firstHeight = parseFloat(firstRect.getAttribute('height') ?? '0');
    expect(firstHeight).toBe(1);
  });

  it('renders an SVG element', () => {
    const { container } = render(<ActivitySparkline data={[1, 2, 3, 4, 5, 6, 7]} />);

    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 100 30');
  });

  it('accepts a custom className', () => {
    const { container } = render(
      <ActivitySparkline data={[1, 2, 3, 4, 5, 6, 7]} className="custom-class" />
    );

    const svg = container.querySelector('svg');
    // svg.className is SVGAnimatedString in jsdom; use getAttribute for reliable string access
    expect(svg?.getAttribute('class')).toContain('custom-class');
  });
});
