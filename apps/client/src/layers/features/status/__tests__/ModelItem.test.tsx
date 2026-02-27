// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { ModelItem } from '../ui/ModelItem';

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

const mockModels = [
  { value: 'claude-sonnet-4-5-20250929', displayName: 'Sonnet 4.5', description: 'Fast model' },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Capable model' },
];

function createWrapper() {
  const transport = createMockTransport({ getModels: vi.fn().mockResolvedValue(mockModels) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  };
}

describe('ModelItem', () => {
  it('renders the current model display name', async () => {
    render(
      <ModelItem model="claude-opus-4-6" onChangeModel={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    expect(await screen.findByText('Opus 4.6')).toBeInTheDocument();
  });

  it('falls back to extracted name for unknown models', () => {
    render(
      <ModelItem model="claude-unknown-1-0-20260101" onChangeModel={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });
});
