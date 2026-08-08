/**
 * @vitest-environment jsdom
 */
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    children?: ReactNode;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

import { NotFoundFallback } from '../not-found-fallback';

afterEach(cleanup);

describe('NotFoundFallback', () => {
  it('renders "Page not found" heading', () => {
    render(<NotFoundFallback />);
    expect(screen.getByText('Page not found')).toBeInTheDocument();
  });

  it('renders description text', () => {
    render(<NotFoundFallback />);
    expect(screen.getByText(/the page you're looking for/i)).toBeInTheDocument();
  });

  it('renders "Back to Home" link pointing to "/"', () => {
    render(<NotFoundFallback />);
    const link = screen.getByRole('link', { name: /back to home/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/');
  });

  it('renders Search icon', () => {
    const { container } = render(<NotFoundFallback />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });
});
