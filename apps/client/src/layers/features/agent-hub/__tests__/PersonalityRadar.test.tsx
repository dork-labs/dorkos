/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PersonalityRadar } from '../ui/PersonalityRadar';

const defaultTraits = { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 };

afterEach(cleanup);

describe('PersonalityRadar', () => {
  it('renders an SVG with role="img" and accessible label', () => {
    render(<PersonalityRadar traits={defaultTraits} />);
    const svg = screen.getByRole('img', { name: 'Personality radar chart' });
    expect(svg).toBeInTheDocument();
    expect(svg.tagName).toBe('svg');
  });

  it('renders 5 axis labels', () => {
    render(<PersonalityRadar traits={defaultTraits} />);
    expect(screen.getByText('Tone')).toBeInTheDocument();
    expect(screen.getByText('Autonomy')).toBeInTheDocument();
    expect(screen.getByText('Caution')).toBeInTheDocument();
    expect(screen.getByText('Communication')).toBeInTheDocument();
    expect(screen.getByText('Creativity')).toBeInTheDocument();
  });

  it('renders 3 concentric guide ring polygons', () => {
    const { container } = render(<PersonalityRadar traits={defaultTraits} />);
    // Guide rings + 1 data polygon = 4 total polygons
    const polygons = container.querySelectorAll('polygon');
    expect(polygons.length).toBe(4);
  });

  it('renders 5 data point circles', () => {
    const { container } = render(<PersonalityRadar traits={defaultTraits} />);
    const circles = container.querySelectorAll('circle');
    expect(circles.length).toBe(5);
  });

  it('renders 5 axis lines', () => {
    const { container } = render(<PersonalityRadar traits={defaultTraits} />);
    const lines = container.querySelectorAll('line');
    expect(lines.length).toBe(5);
  });

  it('includes animate elements when animated=true (default)', () => {
    const { container } = render(<PersonalityRadar traits={defaultTraits} />);
    const animates = container.querySelectorAll('animate');
    // 1 polygon animate + 5 circle animates = 6
    expect(animates.length).toBe(6);
  });

  it('excludes animate elements when animated=false', () => {
    const { container } = render(<PersonalityRadar traits={defaultTraits} animated={false} />);
    const animates = container.querySelectorAll('animate');
    expect(animates.length).toBe(0);
  });

  it('respects custom size prop', () => {
    render(<PersonalityRadar traits={defaultTraits} size={200} />);
    const svg = screen.getByRole('img');
    expect(svg).toHaveAttribute('width', '200');
    expect(svg).toHaveAttribute('height', '200');
    expect(svg).toHaveAttribute('viewBox', '0 0 200 200');
  });
});
