// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';

// Mock motion/react to render plain elements
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

import { ShortcutChips } from '../ui/ShortcutChips';

afterEach(() => {
  cleanup();
});

describe('ShortcutChips', () => {
  it('renders both chips with correct labels', () => {
    const { container } = render(<ShortcutChips onChipClick={vi.fn()} />);
    expect(container.textContent).toContain('Commands');
    expect(container.textContent).toContain('Files');
  });

  it('calls onChipClick with "/" when Commands chip is clicked', () => {
    const onChipClick = vi.fn();
    const { container } = render(<ShortcutChips onChipClick={onChipClick} />);
    const commandsBtn = container.querySelector('button[aria-label="Insert slash command trigger"]')!;
    fireEvent.click(commandsBtn);
    expect(onChipClick).toHaveBeenCalledWith('/');
  });

  it('calls onChipClick with "@" when Files chip is clicked', () => {
    const onChipClick = vi.fn();
    const { container } = render(<ShortcutChips onChipClick={onChipClick} />);
    const filesBtn = container.querySelector('button[aria-label="Insert file mention trigger"]')!;
    fireEvent.click(filesBtn);
    expect(onChipClick).toHaveBeenCalledWith('@');
  });

  it('renders chips as accessible buttons with aria-labels', () => {
    const { container } = render(<ShortcutChips onChipClick={vi.fn()} />);
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    expect(container.querySelector('[aria-label="Insert slash command trigger"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Insert file mention trigger"]')).not.toBeNull();
  });

  it('renders trigger characters in kbd elements', () => {
    const { container } = render(<ShortcutChips onChipClick={vi.fn()} />);
    const kbds = container.querySelectorAll('kbd');
    expect(kbds).toHaveLength(2);
    expect(kbds[0].textContent).toBe('/');
    expect(kbds[1].textContent).toBe('@');
  });
});
