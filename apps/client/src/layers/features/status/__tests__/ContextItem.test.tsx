// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { STATUS_TONE_TEXT, TooltipProvider } from '@/layers/shared/ui';
import { ContextItem } from '../ui/ContextItem';
import type { ContextUsage } from '@dorkos/shared/types';

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

afterEach(cleanup);

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

  it('applies the warning tint at 80%', () => {
    const usage: ContextUsage = { ...mockContextUsage, percentage: 82 };
    const { container } = render(<ContextItem percent={82} contextUsage={usage} />, {
      wrapper: Wrapper,
    });
    expect(container.querySelector(`.${STATUS_TONE_TEXT.warning}`)).not.toBeNull();
  });

  it('applies the error tint at 95%', () => {
    const usage: ContextUsage = { ...mockContextUsage, percentage: 97 };
    const { container } = render(<ContextItem percent={97} contextUsage={usage} />, {
      wrapper: Wrapper,
    });
    expect(container.querySelector(`.${STATUS_TONE_TEXT.error}`)).not.toBeNull();
  });

  it('renders without tooltip when contextUsage is null', () => {
    const { container } = render(<ContextItem percent={50} contextUsage={null} />, {
      wrapper: Wrapper,
    });
    // No tooltip trigger wrapper when no context usage
    expect(container.querySelector('[data-state]')).toBeNull();
  });

  it('shows the tooltip trigger for the simple (category-less) payload', () => {
    // The server emits an accurate context_usage with no per-category breakdown;
    // the SDK percentage and the "used / max" tooltip trigger must still render.
    const usage: ContextUsage = { ...mockContextUsage, percentage: 12, categories: [] };
    const { container } = render(<ContextItem percent={3} contextUsage={usage} />, {
      wrapper: Wrapper,
    });

    expect(screen.getByText('12%')).toBeInTheDocument();
    expect(container.querySelector('[aria-label="Context window usage"]')).not.toBeNull();
  });
});

describe('ContextItem — the inline Compact action', () => {
  const compact = { pending: false, onCompact: vi.fn() };

  it('stays out of the way below the action threshold', () => {
    render(<ContextItem percent={84} compact={compact} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('compaction-chip')).toBeNull();
  });

  it('appears at the action threshold', () => {
    render(<ContextItem percent={85} compact={compact} />, { wrapper: Wrapper });
    expect(screen.getByTestId('compaction-chip')).toBeInTheDocument();
  });

  it('never appears when the runtime cannot compact', () => {
    render(<ContextItem percent={97} compact={null} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('compaction-chip')).toBeNull();
  });

  it('names the exact percent it is offering to fix', () => {
    // The number in the label and the badge beside it come from one resolution, so
    // they can never disagree.
    render(
      <ContextItem
        percent={99}
        contextUsage={{ ...mockContextUsage, percentage: 88 }}
        compact={compact}
      />,
      {
        wrapper: Wrapper,
      }
    );
    expect(screen.getByText('88%')).toBeInTheDocument();
    expect(screen.getByLabelText('Context 88% full. Compact now')).toBeInTheDocument();
  });

  it('fires the compact intent when clicked', () => {
    const onCompact = vi.fn();
    render(<ContextItem percent={91} compact={{ pending: false, onCompact }} />, {
      wrapper: Wrapper,
    });
    fireEvent.click(screen.getByTestId('compaction-chip'));
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it('is disabled and says so while a compaction is in flight', () => {
    render(<ContextItem percent={91} compact={{ pending: true, onCompact: vi.fn() }} />, {
      wrapper: Wrapper,
    });
    const button = screen.getByTestId('compaction-chip');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByLabelText('Compacting conversation…')).toBeInTheDocument();
  });
});

describe('ContextItem — every part can give up pixels except the number', () => {
  /** The percent reading, whatever the surrounding markup is. */
  function percentSpan(text: string): HTMLElement {
    return screen.getByText(text);
  }

  it('lets the Compact action absorb the squeeze and keeps the percent whole', () => {
    // The row can hand an item less width than its content needs, so something in
    // the item has to be shrinkable. Both halves shipped `shrink-0`, so the item
    // rendered 39px wider than its box and painted over the item beside it
    // (DOR-461). The action gives way; the number does not.
    render(<ContextItem percent={91} compact={{ pending: false, onCompact: vi.fn() }} />, {
      wrapper: Wrapper,
    });
    const button = screen.getByTestId('compaction-chip');
    expect(button.className).toContain('min-w-0');
    expect(button.className).toContain('shrink');
    expect(button.className).not.toContain('shrink-0');
    expect(button.querySelector('span.truncate')).not.toBeNull();
    expect(percentSpan('91%').parentElement!.className).toContain('shrink-0');
    expect(percentSpan('91%').className).not.toContain('truncate');
  });

  it('never truncates the percent, with or without the action beside it', () => {
    // `88%` cut to `8…` is not the same fact in fewer letters, it is a different
    // number — wrong by 10x, and worse than the item not being there (DOR-461
    // review). The registry marks this item rigid so the row cannot squeeze it;
    // the absence of a `truncate` is the same promise one level down.
    for (const compact of [null, { pending: false, onCompact: vi.fn() }]) {
      cleanup();
      render(<ContextItem percent={88} compact={compact} />, { wrapper: Wrapper });
      const value = percentSpan('88%');
      expect(value.className).not.toContain('truncate');
      expect(value.parentElement!.className).toContain('shrink-0');
    }
  });
});
