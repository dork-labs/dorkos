/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUseDeniedAgents = vi.fn();

vi.mock('@/layers/entities/mesh', () => ({
  useDeniedAgents: () => mockUseDeniedAgents(),
}));

vi.mock('@/layers/features/mesh', () => ({
  MeshEmptyState: ({ headline }: { headline: string }) => (
    <div data-testid="mesh-empty-state">{headline}</div>
  ),
}));

import { DeniedView } from '../ui/DeniedView';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

afterEach(cleanup);

describe('DeniedView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state with spinner', () => {
    mockUseDeniedAgents.mockReturnValue({ data: undefined, isLoading: true });
    render(<DeniedView />, { wrapper: createWrapper() });
    // Loader2 has animate-spin class
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('renders empty state when no denied paths', () => {
    mockUseDeniedAgents.mockReturnValue({ data: { denied: [] }, isLoading: false });
    render(<DeniedView />, { wrapper: createWrapper() });
    expect(screen.getByTestId('mesh-empty-state')).toBeInTheDocument();
    expect(screen.getByText('No blocked paths')).toBeInTheDocument();
  });

  it('renders list of denied paths with metadata', () => {
    mockUseDeniedAgents.mockReturnValue({
      data: {
        denied: [
          { path: '/opt/agents/bad', reason: 'Not authorized', deniedBy: 'admin' },
          { path: '/tmp/test', reason: null, deniedBy: 'user' },
        ],
      },
      isLoading: false,
    });
    render(<DeniedView />, { wrapper: createWrapper() });
    expect(screen.getByText('/opt/agents/bad')).toBeInTheDocument();
    expect(screen.getByText('Not authorized')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.getByText('/tmp/test')).toBeInTheDocument();
    expect(screen.getByText('user')).toBeInTheDocument();
  });

  it('does not render reason when reason is null', () => {
    mockUseDeniedAgents.mockReturnValue({
      data: {
        denied: [{ path: '/tmp/test', reason: null, deniedBy: 'user' }],
      },
      isLoading: false,
    });
    render(<DeniedView />, { wrapper: createWrapper() });
    expect(screen.getByText('/tmp/test')).toBeInTheDocument();
    // Only the path and badge should be present, no reason text
    const paragraphs = document.querySelectorAll('p');
    // One <p> for path, none for reason (since reason is null)
    expect(paragraphs.length).toBe(1);
  });
});
