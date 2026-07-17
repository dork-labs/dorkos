// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CompactionChip } from '../CompactionChip';

afterEach(() => {
  cleanup();
});

describe('CompactionChip', () => {
  it('renders the live percent in the button and exposes it via aria-label (a11y)', () => {
    render(<CompactionChip percent={82} pending={false} onClick={vi.fn()} />);
    const button = screen.getByRole('button', { name: /context 82% full/i });
    expect(button).toBeInTheDocument();
    expect(button).not.toBeDisabled();
  });

  it('fires onClick when clicked', () => {
    const onClick = vi.fn();
    render(<CompactionChip percent={82} pending={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('disables itself and reflects the in-flight state while pending', () => {
    render(<CompactionChip percent={82} pending={true} onClick={vi.fn()} />);
    const button = screen.getByRole('button', { name: /compacting/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });
});
