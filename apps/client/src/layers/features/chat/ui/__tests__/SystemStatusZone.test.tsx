/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SystemStatusZone } from '../SystemStatusZone';

describe('SystemStatusZone', () => {
  it('renders nothing when message is null', () => {
    const { container } = render(<SystemStatusZone message={null} />);
    expect(container.textContent).toBe('');
  });

  it('renders message text when present', () => {
    render(<SystemStatusZone message="Compacting context..." />);
    expect(screen.getByText('Compacting context...')).toBeInTheDocument();
  });

  it('renders with the expected styling classes', () => {
    render(<SystemStatusZone message="Test status" />);
    const text = screen.getByText('Test status');
    expect(text.tagName).toBe('SPAN');
    expect(text.className).toContain('text-xs');
  });
});
