// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/layers/shared/ui';
import { SystemHealthDot } from '../ui/SystemHealthDot';

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

function renderDot(state: 'healthy' | 'degraded' | 'error') {
  return render(
    <TooltipProvider>
      <SystemHealthDot state={state} />
    </TooltipProvider>
  );
}

describe('SystemHealthDot', () => {
  it('renders with muted color class for healthy state', () => {
    const { container } = renderDot('healthy');
    const dot = container.querySelector('span');
    expect(dot).toBeInTheDocument();
    expect(dot?.className).toContain('bg-muted-foreground/30');
  });

  it('renders with amber color class for degraded state', () => {
    const { container } = renderDot('degraded');
    const dot = container.querySelector('span');
    expect(dot?.className).toContain('bg-amber-500');
  });

  it('renders with red color class for error state', () => {
    const { container } = renderDot('error');
    const dot = container.querySelector('span');
    expect(dot?.className).toContain('bg-red-500');
  });

  it('has aria-label for healthy state', () => {
    const { container } = renderDot('healthy');
    const dot = container.querySelector('span');
    expect(dot).toHaveAttribute('aria-label', 'All systems operational');
  });

  it('has aria-label for degraded state', () => {
    const { container } = renderDot('degraded');
    const dot = container.querySelector('span');
    expect(dot).toHaveAttribute('aria-label', 'Some adapters disconnected');
  });

  it('has aria-label for error state', () => {
    const { container } = renderDot('error');
    const dot = container.querySelector('span');
    expect(dot).toHaveAttribute('aria-label', 'Issues detected — check Needs Attention');
  });

  it('renders as a span element', () => {
    const { container } = renderDot('healthy');
    const dot = container.querySelector('span');
    expect(dot?.tagName.toLowerCase()).toBe('span');
  });
});
