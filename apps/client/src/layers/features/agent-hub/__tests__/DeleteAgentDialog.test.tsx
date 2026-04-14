/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDeleteMutate = vi.fn();
vi.mock('@/layers/entities/mesh', () => ({
  useDeleteAgentData: () => ({ mutate: mockDeleteMutate }),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

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

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const defaultProps = {
  agentId: 'agent-1',
  agentName: 'Frontend Agent',
  projectPath: '/home/user/frontend',
  open: true,
  onOpenChange: vi.fn(),
};

// ---------------------------------------------------------------------------
// Import component and mocked modules after mocks
// ---------------------------------------------------------------------------

import { DeleteAgentDialog } from '../ui/DeleteAgentDialog';
import { toast } from 'sonner';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(cleanup);

describe('DeleteAgentDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders agent name in dialog title', () => {
    render(<DeleteAgentDialog {...defaultProps} />, { wrapper: createWrapper() });
    expect(screen.getByText('Delete Frontend Agent & Data')).toBeInTheDocument();
  });

  it('renders project path info in dialog description', () => {
    render(<DeleteAgentDialog {...defaultProps} />, { wrapper: createWrapper() });
    expect(screen.getByText('/home/user/frontend/.dork/')).toBeInTheDocument();
  });

  it('renders confirmation input with agent name as placeholder', () => {
    render(<DeleteAgentDialog {...defaultProps} />, { wrapper: createWrapper() });
    const input = screen.getByTestId('delete-confirm-input');
    expect(input).toHaveAttribute('placeholder', 'Frontend Agent');
  });

  it('delete button is disabled when confirmation input is empty', () => {
    render(<DeleteAgentDialog {...defaultProps} />, { wrapper: createWrapper() });
    const deleteBtn = screen.getByRole('button', { name: /delete agent/i });
    expect(deleteBtn).toBeDisabled();
  });

  it('delete button is disabled when confirmation input does not match agent name', () => {
    render(<DeleteAgentDialog {...defaultProps} />, { wrapper: createWrapper() });
    const input = screen.getByTestId('delete-confirm-input');
    fireEvent.change(input, { target: { value: 'frontend agent' } });

    const deleteBtn = screen.getByRole('button', { name: /delete agent/i });
    expect(deleteBtn).toBeDisabled();
  });

  it('delete button becomes enabled when input matches agent name exactly', () => {
    render(<DeleteAgentDialog {...defaultProps} />, { wrapper: createWrapper() });
    const input = screen.getByTestId('delete-confirm-input');
    fireEvent.change(input, { target: { value: 'Frontend Agent' } });

    const deleteBtn = screen.getByRole('button', { name: /delete agent/i });
    expect(deleteBtn).toBeEnabled();
  });

  it('calls useDeleteAgentData mutation on confirm click', () => {
    render(<DeleteAgentDialog {...defaultProps} />, { wrapper: createWrapper() });
    const input = screen.getByTestId('delete-confirm-input');
    fireEvent.change(input, { target: { value: 'Frontend Agent' } });

    fireEvent.click(screen.getByRole('button', { name: /delete agent/i }));
    expect(mockDeleteMutate).toHaveBeenCalledWith('agent-1', expect.any(Object));
  });

  it('calls onOpenChange when cancel button is clicked', () => {
    const onOpenChange = vi.fn();
    render(<DeleteAgentDialog {...defaultProps} onOpenChange={onOpenChange} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('confirm button has destructive styling', () => {
    render(<DeleteAgentDialog {...defaultProps} />, { wrapper: createWrapper() });
    const deleteBtn = screen.getByRole('button', { name: /delete agent/i });
    expect(deleteBtn).toHaveClass('bg-destructive');
    expect(deleteBtn).toHaveClass('text-destructive-foreground');
  });

  it('shows toast and closes dialog on successful deletion', () => {
    mockDeleteMutate.mockImplementation((_id: string, opts: { onSuccess: () => void }) => {
      opts.onSuccess();
    });
    const onOpenChange = vi.fn();

    render(<DeleteAgentDialog {...defaultProps} onOpenChange={onOpenChange} />, {
      wrapper: createWrapper(),
    });
    const input = screen.getByTestId('delete-confirm-input');
    fireEvent.change(input, { target: { value: 'Frontend Agent' } });
    fireEvent.click(screen.getByRole('button', { name: /delete agent/i }));

    expect(toast.error).toHaveBeenCalledWith('Deleted Frontend Agent and all data');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
