// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createMockSession } from '@dorkos/test-utils';
import { TooltipProvider } from '@/layers/shared/ui';
import { RecentSessionRow } from '../ui/RecentSessionRow';

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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

describe('RecentSessionRow', () => {
  it('shows the origin mark for a non-user session, between the title and the timestamp', () => {
    render(
      <RecentSessionRow
        session={createMockSession({ origin: 'channel', originLabel: 'Telegram' })}
        agent={null}
        displayName="warden"
        onClick={() => {}}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByLabelText('Origin: Telegram')).toBeDefined();
  });

  it('shows no origin mark for a user-origin session', () => {
    render(
      <RecentSessionRow
        session={createMockSession()}
        agent={null}
        displayName="warden"
        onClick={() => {}}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.queryByLabelText(/^Origin:/)).toBeNull();
  });
});
