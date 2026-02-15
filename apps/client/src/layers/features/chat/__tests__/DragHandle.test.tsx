// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('motion/react', () => ({
  motion: new Proxy({}, {
    get: (_target: unknown, prop: string) => {
      return ({ children, initial: _i, animate: _a, exit: _e, transition: _t, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => {
        const Tag = prop as keyof React.JSX.IntrinsicElements;
        return <Tag {...props}>{children}</Tag>;
      };
    },
  }),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { DragHandle } from '../ui/DragHandle';

describe('DragHandle', () => {
  const mockOnToggle = vi.fn();

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders pill element', () => {
    render(<DragHandle collapsed={false} onToggle={mockOnToggle} />);
    const handle = screen.getByRole('button');
    const pill = handle.querySelector('div');
    expect(pill).not.toBeNull();
    expect(pill?.className).toContain('w-9');
    expect(pill?.className).toContain('h-1');
    expect(pill?.className).toContain('rounded-full');
  });

  it('displays correct aria-label when expanded', () => {
    render(<DragHandle collapsed={false} onToggle={mockOnToggle} />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Collapse input extras');
  });

  it('displays correct aria-label when collapsed', () => {
    render(<DragHandle collapsed={true} onToggle={mockOnToggle} />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Expand input extras');
  });

  it('calls onToggle on click', () => {
    render(<DragHandle collapsed={false} onToggle={mockOnToggle} />);
    fireEvent.click(screen.getByRole('button'));
    expect(mockOnToggle).toHaveBeenCalledTimes(1);
  });

  it('calls onToggle on Enter key', () => {
    render(<DragHandle collapsed={false} onToggle={mockOnToggle} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
    expect(mockOnToggle).toHaveBeenCalledTimes(1);
  });

  it('has button role', () => {
    render(<DragHandle collapsed={false} onToggle={mockOnToggle} />);
    expect(screen.getByRole('button')).toBeTruthy();
  });
});
