/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PersonalityRadar } from '../ui/PersonalityRadar';

const defaultTraits = {
  verbosity: 3,
  autonomy: 3,
  chaos: 3,
  creativity: 3,
  humor: 3,
  spice: 3,
};

afterEach(cleanup);

describe('PersonalityRadar', () => {
  it('renders an SVG with role="img" and accessible label', () => {
    render(<PersonalityRadar traits={defaultTraits} />);
    const svg = screen.getByRole('img', { name: 'Personality radar chart' });
    expect(svg).toBeInTheDocument();
    expect(svg.tagName).toBe('svg');
  });

  it('renders 6 axis labels', () => {
    render(<PersonalityRadar traits={defaultTraits} />);
    expect(screen.getByText('Verbosity')).toBeInTheDocument();
    expect(screen.getByText('Autonomy')).toBeInTheDocument();
    expect(screen.getByText('Chaos')).toBeInTheDocument();
    expect(screen.getByText('Creativity')).toBeInTheDocument();
    expect(screen.getByText('Humor')).toBeInTheDocument();
    expect(screen.getByText('Spice')).toBeInTheDocument();
  });

  it('renders 3 concentric guide ring polygons plus data polygon', () => {
    const { container } = render(<PersonalityRadar traits={defaultTraits} />);
    // 3 guide rings + 1 data polygon = 4 total
    const polygons = container.querySelectorAll('polygon');
    expect(polygons.length).toBe(4);
  });

  it('renders vertex halos and dots for each axis', () => {
    const { container } = render(<PersonalityRadar traits={defaultTraits} />);
    // 6 halo circles + 6 dot circles = 12 vertex circles
    // Plus: 1 nebula core + 1 flash + 1 breathing ring + 5 stardust = 8 others
    // Total circles when animated: 20
    const circles = container.querySelectorAll('circle');
    expect(circles.length).toBe(20);
  });

  it('renders 6 axis lines', () => {
    const { container } = render(<PersonalityRadar traits={defaultTraits} />);
    const lines = container.querySelectorAll('line');
    expect(lines.length).toBe(6);
  });

  it('includes animate elements when animated=true (default)', () => {
    const { container } = render(<PersonalityRadar traits={defaultTraits} />);
    // 2 animateTransform (nebula layers) + 2 animate (breathing ring) +
    // 5 animateMotion (stardust) + 5 animate (stardust opacity) = 14
    const animates = container.querySelectorAll('animate, animateTransform, animateMotion');
    expect(animates.length).toBe(14);
  });

  it('excludes animate elements when animated=false', () => {
    const { container } = render(<PersonalityRadar traits={defaultTraits} animated={false} />);
    const animates = container.querySelectorAll('animate, animateTransform, animateMotion');
    expect(animates.length).toBe(0);
  });

  it('respects custom size prop in viewBox', () => {
    render(<PersonalityRadar traits={defaultTraits} size={200} />);
    const svg = screen.getByRole('img');
    expect(svg).toHaveAttribute('viewBox', '0 0 200 200');
    expect(svg).not.toHaveAttribute('width');
    expect(svg).not.toHaveAttribute('height');
  });
});
