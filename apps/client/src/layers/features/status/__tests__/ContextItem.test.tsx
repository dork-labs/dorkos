// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/layers/shared/ui';
import { ContextItem } from '../ui/ContextItem';
import type { ContextUsage } from '@dorkos/shared/types';

vi.mock('motion/react', () => ({
  motion: new Proxy({}, { get: (_, tag) => tag }),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

const mockContextUsage: ContextUsage = {
  totalTokens: 42000,
  maxTokens: 200000,
  percentage: 21,
  model: 'claude-opus-4-6',
  categories: [
    { name: 'Messages', tokens: 30000, color: '#4CAF50' },
    { name: 'System Prompt', tokens: 8000, color: '#2196F3' },
    { name: 'Tools', tokens: 4000, color: '#FF9800' },
    { name: 'Empty Category', tokens: 0, color: '#999' },
  ],
};

describe('ContextItem', () => {
  it('renders basic percentage without contextUsage', () => {
    render(<ContextItem percent={45} />, { wrapper: Wrapper });
    expect(screen.getByText('45%')).toBeInTheDocument();
  });

  it('uses SDK percentage when contextUsage is provided', () => {
    render(<ContextItem percent={45} contextUsage={mockContextUsage} />, { wrapper: Wrapper });
    // SDK says 21% — should be visible
    expect(screen.getByText('21%')).toBeInTheDocument();
  });

  it('applies amber color class at 80%', () => {
    const usage: ContextUsage = { ...mockContextUsage, percentage: 82 };
    const { container } = render(<ContextItem percent={82} contextUsage={usage} />, {
      wrapper: Wrapper,
    });
    expect(container.querySelector('.text-amber-500')).not.toBeNull();
  });

  it('applies red color class at 95%', () => {
    const usage: ContextUsage = { ...mockContextUsage, percentage: 97 };
    const { container } = render(<ContextItem percent={97} contextUsage={usage} />, {
      wrapper: Wrapper,
    });
    expect(container.querySelector('.text-red-500')).not.toBeNull();
  });

  it('renders without tooltip when contextUsage is null', () => {
    const { container } = render(<ContextItem percent={50} contextUsage={null} />, {
      wrapper: Wrapper,
    });
    // No tooltip trigger wrapper when no context usage
    expect(container.querySelector('[data-state]')).toBeNull();
  });
});
