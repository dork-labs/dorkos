/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/layers/shared/ui';
import { RuntimeMark } from '../ui/RuntimeMark';

// Mock window.matchMedia for useIsMobile hook (used by shared tooltip).
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

  // Radix UI's @radix-ui/react-use-size calls ResizeObserver which jsdom doesn't provide.
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(cleanup);

function Wrapper({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

describe('RuntimeMark', () => {
  it('renders the runtime label as an accessible name', () => {
    render(<RuntimeMark type="codex" />, { wrapper: Wrapper });
    expect(screen.getByLabelText('Runtime: Codex')).toBeDefined();
  });

  it('renders an svg icon for known runtimes', () => {
    const { container } = render(<RuntimeMark type="opencode" />, { wrapper: Wrapper });
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('falls back to the raw type for unknown runtimes', () => {
    render(<RuntimeMark type="made-up" />, { wrapper: Wrapper });
    expect(screen.getByLabelText('Runtime: made-up')).toBeDefined();
  });

  it('folds the model into the identity as runtime · model', () => {
    render(<RuntimeMark type="opencode" model="ollama/qwen2.5-coder" />, { wrapper: Wrapper });
    expect(screen.getByLabelText('Runtime: OpenCode · qwen2.5-coder')).toBeDefined();
  });

  it('degrades to the runtime alone when no model is resolved', () => {
    render(<RuntimeMark type="opencode" model={null} />, { wrapper: Wrapper });
    expect(screen.getByLabelText('Runtime: OpenCode')).toBeDefined();
  });
});
