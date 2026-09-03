/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { AggregatedDeadLetter } from '@/layers/entities/relay';

// ---------------------------------------------------------------------------
// Mocks — must be before imports
// ---------------------------------------------------------------------------

const mockUseAggregatedDeadLetters = vi.fn<() => { data: AggregatedDeadLetter[] | undefined }>(
  () => ({ data: undefined })
);
const mockDismissMutate = vi.fn();
const mockUseDismissDeadLetterGroup = vi.fn(() => ({
  mutate: mockDismissMutate,
  isPending: false,
}));

vi.mock('@/layers/entities/relay', () => ({
  useAggregatedDeadLetters: () => mockUseAggregatedDeadLetters(),
  useDismissDeadLetterGroup: () => mockUseDismissDeadLetterGroup(),
}));

// Mock Sheet components — they use portals which don't work in jsdom.
// Render children directly so test assertions work against rendered content.
// Everything else comes through untouched, so the real Collapsible (and any
// primitive this sheet reaches for next) behaves as it does in the app.
vi.mock('@/layers/shared/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/ui')>()),
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  SheetFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

// Mock formatRelativeTime so timestamp output is deterministic in tests.
vi.mock('@/layers/shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib')>()),
  formatCompactAge: (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h`;
  },
}));

import { DeadLetterDetailSheet } from '../ui/DeadLetterDetailSheet';

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

function makeDeadLetterGroup(overrides: Partial<AggregatedDeadLetter> = {}): AggregatedDeadLetter {
  return {
    source: 'telegram-adapter',
    reason: 'hop_limit',
    count: 3,
    firstSeen: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    lastSeen: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

interface RenderSheetOptions {
  open?: boolean;
  itemId?: string;
  onClose?: () => void;
  deadLetters?: AggregatedDeadLetter[];
}

function renderSheet({
  open = true,
  itemId = 'telegram-adapter::hop_limit',
  onClose = vi.fn(),
  deadLetters,
}: RenderSheetOptions = {}) {
  mockUseAggregatedDeadLetters.mockReturnValue({ data: deadLetters });
  return render(<DeadLetterDetailSheet open={open} itemId={itemId} onClose={onClose} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeadLetterDetailSheet', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseDismissDeadLetterGroup.mockReturnValue({
      mutate: mockDismissMutate,
      isPending: false,
    });
  });

  it('renders the already-cleared line when group is not found', () => {
    renderSheet({ deadLetters: [] });
    expect(screen.getByText('These are cleared already.')).toBeInTheDocument();
  });

  it('renders the already-cleared line when deadLetters data is undefined', () => {
    renderSheet({ deadLetters: undefined });
    expect(screen.getByText('These are cleared already.')).toBeInTheDocument();
  });

  it('renders the already-cleared line when itemId does not match any group', () => {
    renderSheet({
      itemId: 'other-adapter::timeout',
      deadLetters: [makeDeadLetterGroup()],
    });
    expect(screen.getByText('These are cleared already.')).toBeInTheDocument();
  });

  // Plain words, not message-broker words (DOR-1755). This sheet opens straight
  // off Home, so "undeliverable" was one of the first nouns a new person met.
  it('renders message count when group is found', () => {
    renderSheet({ deadLetters: [makeDeadLetterGroup({ count: 5 })] });
    expect(screen.getByText(/5 messages couldn’t be delivered/)).toBeInTheDocument();
    expect(screen.queryByText(/undeliverable/i)).not.toBeInTheDocument();
  });

  it('uses singular form for a single message', () => {
    renderSheet({ deadLetters: [makeDeadLetterGroup({ count: 1 })] });
    expect(screen.getByText(/1 message couldn’t be delivered/)).toBeInTheDocument();
  });

  it('says what these are and what clearing does', () => {
    renderSheet({ deadLetters: [makeDeadLetterGroup()] });
    expect(
      screen.getByText(/meant for an agent and never got there/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Clearing them does not send them/)).toBeInTheDocument();
  });

  it('renders the group reason as a badge', () => {
    renderSheet({ deadLetters: [makeDeadLetterGroup({ reason: 'hop_limit' })] });
    expect(screen.getByText('hop_limit')).toBeInTheDocument();
  });

  it('renders firstSeen and lastSeen timestamps', () => {
    const firstSeen = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const lastSeen = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    renderSheet({ deadLetters: [makeDeadLetterGroup({ firstSeen, lastSeen })] });

    // firstSeen is 2h ago, lastSeen is 30m ago
    expect(screen.getByText(/First happened 2h ago/)).toBeInTheDocument();
    expect(screen.getByText(/Last happened 30m ago/)).toBeInTheDocument();
  });

  it('renders source in the sheet description', () => {
    renderSheet({ deadLetters: [makeDeadLetterGroup({ source: 'telegram-adapter' })] });
    expect(screen.getByText('telegram-adapter')).toBeInTheDocument();
  });

  it('folds the example away, and still carries it', () => {
    const sample = { type: 'message', text: 'Hello' };
    renderSheet({ deadLetters: [makeDeadLetterGroup({ sample })] });
    // The raw JSON is behind a closed disclosure now: useful to whoever wants
    // it, noise to everyone else (DOR-1755).
    const trigger = screen.getByRole('button', { name: 'What one of them looked like' });
    expect(trigger).toHaveAttribute('data-state', 'closed');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('data-state', 'open');
    const pre = document.querySelector('pre');
    expect(pre).toBeTruthy();
    expect(pre!.textContent).toContain('"type": "message"');
  });

  it('does not render the example section when there is no sample', () => {
    renderSheet({ deadLetters: [makeDeadLetterGroup({ sample: undefined })] });
    expect(screen.queryByText('What one of them looked like')).not.toBeInTheDocument();
  });

  it('renders Clear these button when group is found', () => {
    renderSheet({ deadLetters: [makeDeadLetterGroup()] });
    expect(screen.getByRole('button', { name: 'Clear these' })).toBeInTheDocument();
  });

  it('does not render Clear these button when group is not found', () => {
    renderSheet({ deadLetters: [] });
    expect(screen.queryByRole('button', { name: 'Clear these' })).not.toBeInTheDocument();
  });

  it('calls dismiss mutation with source and reason when Clear these is clicked', () => {
    renderSheet({
      deadLetters: [makeDeadLetterGroup({ source: 'telegram-adapter', reason: 'hop_limit' })],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Clear these' }));

    expect(mockDismissMutate).toHaveBeenCalledWith(
      { source: 'telegram-adapter', reason: 'hop_limit' },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it('dismiss mutation onSuccess calls onClose', () => {
    const onClose = vi.fn();
    renderSheet({
      onClose,
      deadLetters: [makeDeadLetterGroup()],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Clear these' }));

    // Extract and invoke the onSuccess callback passed to mutate
    const [, { onSuccess }] = mockDismissMutate.mock.calls[0] as [
      unknown,
      { onSuccess: () => void },
    ];
    onSuccess();

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('disables Clear these button when mutation is pending', () => {
    mockUseDismissDeadLetterGroup.mockReturnValue({
      mutate: mockDismissMutate,
      isPending: true,
    });
    renderSheet({ deadLetters: [makeDeadLetterGroup()] });

    expect(screen.getByRole('button', { name: 'Clearing…' })).toBeDisabled();
  });

  it('renders Close button', () => {
    renderSheet({ deadLetters: [makeDeadLetterGroup()] });
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('calls onClose when Close button is clicked', () => {
    const onClose = vi.fn();
    renderSheet({ onClose, deadLetters: [makeDeadLetterGroup()] });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders Close button even when group is not found', () => {
    const onClose = vi.fn();
    renderSheet({ onClose, deadLetters: [] });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('parses itemId compound key correctly when source contains no double colon', () => {
    const group = makeDeadLetterGroup({ source: 'slack-bot', reason: 'timeout' });
    renderSheet({ itemId: 'slack-bot::timeout', deadLetters: [group] });
    expect(screen.getByText(/3 messages couldn’t be delivered/)).toBeInTheDocument();
  });
});
