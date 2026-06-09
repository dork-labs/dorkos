// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/layers/shared/ui';
import { CacheItem } from '../ui/CacheItem';

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

describe('CacheItem', () => {
  it('computes hit rate against the full context without double-counting', () => {
    // contextTokens is the full request input (already includes the cache terms).
    // It must be the denominator directly — not summed with cacheRead/Creation
    // again (the pre-fix bug, which halved a fully-cached request to 50%).
    render(<CacheItem cacheReadTokens={100} cacheCreationTokens={0} contextTokens={100} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('falls back to cache totals when contextTokens is absent', () => {
    render(<CacheItem cacheReadTokens={30} cacheCreationTokens={10} />, { wrapper: Wrapper });
    // 30 / (30 + 10) = 75%
    expect(screen.getByText('75%')).toBeInTheDocument();
  });

  it('shows 0% when there are no tokens', () => {
    render(<CacheItem cacheReadTokens={0} cacheCreationTokens={0} contextTokens={0} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('0%')).toBeInTheDocument();
  });
});
