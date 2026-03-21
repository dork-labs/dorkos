// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/layers/shared/ui';
import { ActiveSessionCard } from '../ui/ActiveSessionCard';
import type { ActiveSession } from '../model/use-active-sessions';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderCard(session: Partial<ActiveSession> = {}) {
  const defaults: ActiveSession = {
    id: 'sess-abc',
    title: 'My Session',
    cwd: '/projects/myapp',
    agentName: 'Backend Bot',
    agentEmoji: '🤖',
    agentColor: '#6366f1',
    lastActivity: 'Analyzing codebase...',
    elapsedTime: '15m',
    status: 'active',
    ...session,
  };

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ActiveSessionCard session={defaults} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActiveSessionCard', () => {
  it('renders agent emoji and name', () => {
    renderCard({ agentEmoji: '🤖', agentName: 'Backend Bot' });
    expect(screen.getAllByText('🤖')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Backend Bot')[0]).toBeInTheDocument();
  });

  it('renders last activity text', () => {
    renderCard({ lastActivity: 'Analyzing codebase...' });
    expect(screen.getAllByText('Analyzing codebase...')[0]).toBeInTheDocument();
  });

  it('shows "idle" when lastActivity is empty', () => {
    renderCard({ lastActivity: '' });
    expect(screen.getAllByText('idle')[0]).toBeInTheDocument();
  });

  it('renders elapsed time', () => {
    renderCard({ elapsedTime: '47m' });
    expect(screen.getAllByText('47m')[0]).toBeInTheDocument();
  });

  it('renders Open button', () => {
    renderCard();
    expect(screen.getAllByRole('button', { name: /open/i })[0]).toBeInTheDocument();
  });

  it('Open button navigates to correct session URL', () => {
    renderCard({ id: 'sess-abc', cwd: '/projects/myapp' });
    fireEvent.click(screen.getAllByRole('button', { name: /open/i })[0]);
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { session: 'sess-abc', dir: '/projects/myapp' },
    });
  });

  it('shows blue pulsing dot for active status', () => {
    const { container } = renderCard({ status: 'active' });
    const dot = container.querySelector('.bg-blue-500');
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveClass('animate-pulse');
  });

  it('shows gray dot for idle status', () => {
    const { container } = renderCard({ status: 'idle' });
    const dot = container.querySelector('.bg-muted-foreground\\/30');
    expect(dot).toBeInTheDocument();
    expect(dot).not.toHaveClass('animate-pulse');
  });

  it('activity text has truncate class', () => {
    const { container } = renderCard({ lastActivity: 'A very long activity text' });
    const activityEl = container.querySelector('.truncate');
    expect(activityEl).toBeInTheDocument();
  });
});
