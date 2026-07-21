/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/layers/shared/ui';
import { OriginMark } from '../OriginMark';

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

describe('OriginMark', () => {
  it.each([
    ['agent', 'Agent'],
    ['channel', 'Channel'],
    ['task', 'Scheduled task'],
    ['external', 'External'],
  ] as const)('renders an icon + tooltip for origin=%s with fallback label', (origin, label) => {
    const { container } = render(<OriginMark origin={origin} />, { wrapper: Wrapper });
    expect(screen.getByLabelText(`Origin: ${label}`)).toBeDefined();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('prefers a passed label over the descriptor fallback', () => {
    render(<OriginMark origin="channel" label="Telegram" />, { wrapper: Wrapper });
    expect(screen.getByLabelText('Origin: Telegram')).toBeDefined();
    expect(screen.queryByLabelText('Origin: Channel')).toBeNull();
  });

  it('renders nothing for origin="user"', () => {
    render(<OriginMark origin="user" />, { wrapper: Wrapper });
    expect(screen.queryByLabelText(/^Origin:/)).toBeNull();
  });

  it('renders nothing when origin is absent', () => {
    render(<OriginMark />, { wrapper: Wrapper });
    expect(screen.queryByLabelText(/^Origin:/)).toBeNull();
  });

  it('renders nothing for an unrecognized origin string', () => {
    render(<OriginMark origin="bogus" />, { wrapper: Wrapper });
    expect(screen.queryByLabelText(/^Origin:/)).toBeNull();
  });
});
