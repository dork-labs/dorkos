/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { TaskRun } from '@dorkos/shared/types';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that depend on them
// ---------------------------------------------------------------------------

const mockUseRun = vi.fn<
  (id: string | null) => { data: TaskRun | undefined; isLoading: boolean; isError: boolean }
>(() => ({ data: undefined, isLoading: false, isError: false }));
const mockUseCancelRun = vi.fn(() => ({
  mutate: vi.fn(),
  isPending: false,
}));

vi.mock('@/layers/entities/tasks', () => ({
  useTaskRun: (id: string | null) => mockUseRun(id),
  useCancelTaskRun: () => mockUseCancelRun(),
}));

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

// Mock format-relative-time to return deterministic values
vi.mock('../lib/format-relative-time', () => ({
  formatRelativeTime: (_iso: string) => '1h',
}));

// Mock Sheet components — they use portals which don't work in jsdom.
// Render children directly so we can assert on content.
vi.mock('@/layers/shared/ui', () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Badge: ({ children, variant }: { children: React.ReactNode; variant?: string }) => (
    <span data-variant={variant}>{children}</span>
  ),
  Button: ({
    children,
    onClick,
    disabled,
    variant,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
  }) => (
    <button onClick={onClick} disabled={disabled} data-variant={variant}>
      {children}
    </button>
  ),
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Skeleton: ({ className }: { className?: string }) => (
    <div data-testid="skeleton" className={className} />
  ),
}));

import { FailedRunDetailSheet } from '../ui/FailedRunDetailSheet';
import { useInteractionStore } from '@/layers/entities/interactions';

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

function makeRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-abc123',
    scheduleId: 'sched-1',
    status: 'failed',
    startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    finishedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
    durationMs: 30_000,
    outputSummary: null,
    error: null,
    sessionId: null,
    trigger: 'scheduled',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function renderSheet(props: { open?: boolean; itemId?: string; onClose?: () => void } = {}) {
  const onClose = props.onClose ?? vi.fn();
  return render(
    <FailedRunDetailSheet
      open={props.open ?? true}
      itemId={props.itemId ?? 'run-abc123'}
      onClose={onClose}
    />
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FailedRunDetailSheet', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRun.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    mockUseCancelRun.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useInteractionStore.getState().reset();
  });

  it('renders loading skeletons when isLoading is true', () => {
    mockUseRun.mockReturnValue({ data: undefined, isLoading: true, isError: false });

    renderSheet();

    const skeletons = screen.getAllByTestId('skeleton');
    expect(skeletons.length).toBeGreaterThanOrEqual(3);
  });

  it('renders error message when isError is true', () => {
    mockUseRun.mockReturnValue({ data: undefined, isLoading: false, isError: true });

    renderSheet();

    expect(screen.getByText('Failed to load run details.')).toBeInTheDocument();
  });

  it('renders resolved message when no run data is found', () => {
    mockUseRun.mockReturnValue({ data: undefined, isLoading: false, isError: false });

    renderSheet();

    expect(screen.getByText('This item has been resolved.')).toBeInTheDocument();
  });

  it('renders run details with status and trigger badges', () => {
    mockUseRun.mockReturnValue({
      data: makeRun({ trigger: 'scheduled' }),
      isLoading: false,
      isError: false,
    });

    renderSheet();

    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
  });

  it('renders Manual trigger badge for manual runs', () => {
    mockUseRun.mockReturnValue({
      data: makeRun({ trigger: 'manual' }),
      isLoading: false,
      isError: false,
    });

    renderSheet();

    expect(screen.getByText('Manual')).toBeInTheDocument();
  });

  it('renders error block when run has an error message', () => {
    mockUseRun.mockReturnValue({
      data: makeRun({ error: 'Connection timed out after 30s' }),
      isLoading: false,
      isError: false,
    });

    renderSheet();

    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('Connection timed out after 30s')).toBeInTheDocument();
  });

  it('does not render error block when run has no error', () => {
    mockUseRun.mockReturnValue({
      data: makeRun({ error: null }),
      isLoading: false,
      isError: false,
    });

    renderSheet();

    expect(screen.queryByText('Error')).not.toBeInTheDocument();
  });

  it('renders output summary when present', () => {
    mockUseRun.mockReturnValue({
      data: makeRun({ outputSummary: 'Processed 42 items successfully' }),
      isLoading: false,
      isError: false,
    });

    renderSheet();

    expect(screen.getByText('Processed 42 items successfully')).toBeInTheDocument();
  });

  it('renders timeline fields from the run', () => {
    mockUseRun.mockReturnValue({ data: makeRun(), isLoading: false, isError: false });

    renderSheet();

    // formatRelativeTime is mocked to return '1h'
    expect(screen.getByText(/Started:/)).toBeInTheDocument();
    expect(screen.getByText(/Finished:/)).toBeInTheDocument();
    expect(screen.getByText(/Duration:/)).toBeInTheDocument();
  });

  it('renders View Session button when run has a sessionId', () => {
    mockUseRun.mockReturnValue({
      data: makeRun({ sessionId: 'sess-xyz' }),
      isLoading: false,
      isError: false,
    });

    renderSheet();

    expect(screen.getByRole('button', { name: 'View Session' })).toBeInTheDocument();
  });

  it('does not render View Session button when run has no sessionId', () => {
    mockUseRun.mockReturnValue({
      data: makeRun({ sessionId: null }),
      isLoading: false,
      isError: false,
    });

    renderSheet();

    expect(screen.queryByRole('button', { name: 'View Session' })).not.toBeInTheDocument();
  });

  it('View Session button navigates to /session with correct session param', () => {
    mockUseRun.mockReturnValue({
      data: makeRun({ sessionId: 'sess-xyz' }),
      isLoading: false,
      isError: false,
    });

    renderSheet();

    fireEvent.click(screen.getByRole('button', { name: 'View Session' }));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { session: 'sess-xyz' },
    });
    // The other half of the attention section's door (DOR-1156). No directory
    // here — a run's detail carries the session and nothing else.
    expect(Object.keys(useInteractionStore.getState().opened)).toEqual(['session:sess-xyz']);
  });

  it('renders Cancel button when run status is running', () => {
    mockUseRun.mockReturnValue({
      data: makeRun({ status: 'running' }),
      isLoading: false,
      isError: false,
    });

    renderSheet();

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('does not render Cancel button when run is not running', () => {
    mockUseRun.mockReturnValue({
      data: makeRun({ status: 'failed' }),
      isLoading: false,
      isError: false,
    });

    renderSheet();

    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancelling...' })).not.toBeInTheDocument();
  });

  it('Cancel button calls cancelMutation.mutate with the run id', () => {
    const mutate = vi.fn();
    mockUseCancelRun.mockReturnValue({ mutate, isPending: false });
    mockUseRun.mockReturnValue({
      data: makeRun({ id: 'run-abc123', status: 'running' }),
      isLoading: false,
      isError: false,
    });

    renderSheet();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mutate).toHaveBeenCalledWith('run-abc123');
  });

  it('Cancel button is disabled and shows Cancelling... when isPending', () => {
    mockUseCancelRun.mockReturnValue({ mutate: vi.fn(), isPending: true });
    mockUseRun.mockReturnValue({
      data: makeRun({ status: 'running' }),
      isLoading: false,
      isError: false,
    });

    renderSheet();

    const cancelButton = screen.getByRole('button', { name: 'Cancelling...' });
    expect(cancelButton).toBeDisabled();
  });

  it('close button calls onClose', () => {
    const onClose = vi.fn();
    mockUseRun.mockReturnValue({ data: makeRun(), isLoading: false, isError: false });

    render(<FailedRunDetailSheet open={true} itemId="run-abc123" onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders the sheet title and itemId truncated to 8 chars', () => {
    renderSheet({ itemId: 'run-abc123-full-id' });

    expect(screen.getByText('Failed Run')).toBeInTheDocument();
    expect(screen.getByText('run-abc1')).toBeInTheDocument();
  });

  it('shows Unknown in description when itemId is undefined', () => {
    render(<FailedRunDetailSheet open={true} itemId={undefined} onClose={vi.fn()} />);

    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('passes null to useRun when sheet is closed (open=false)', () => {
    // When open=false the component should gate the query by passing null to useRun,
    // preventing a network fetch for a closed sheet.
    render(<FailedRunDetailSheet open={false} itemId="run-abc123" onClose={vi.fn()} />);

    expect(mockUseRun).toHaveBeenCalledWith(null);
  });
});
