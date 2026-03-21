/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AttentionItem } from '../model/use-attention-items';
import { Clock } from 'lucide-react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUseAttentionItems = vi.fn<() => AttentionItem[]>(() => []);
vi.mock('../model/use-attention-items', () => ({
  useAttentionItems: () => mockUseAttentionItems(),
}));

import { NeedsAttentionSection } from '../ui/NeedsAttentionSection';

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

function makeItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'item-1',
    type: 'failed-run',
    icon: Clock,
    title: 'Pulse run failed',
    description: 'A Pulse run failed',
    timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    action: { label: 'View →', onClick: vi.fn() },
    severity: 'error',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NeedsAttentionSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAttentionItems.mockReturnValue([]);
  });

  it('renders nothing when items array is empty', () => {
    const { container } = render(<NeedsAttentionSection />);
    // AnimatePresence removes the section from DOM when items are empty
    const section = container.querySelector('section');
    expect(section).toBeNull();
  });

  it('renders section header when items are present', () => {
    mockUseAttentionItems.mockReturnValue([makeItem()]);
    render(<NeedsAttentionSection />);
    expect(screen.getByText('Needs Attention')).toBeInTheDocument();
  });

  it('renders correct number of items', () => {
    mockUseAttentionItems.mockReturnValue([
      makeItem({ id: 'item-1', description: 'First issue' }),
      makeItem({ id: 'item-2', description: 'Second issue' }),
      makeItem({ id: 'item-3', description: 'Third issue' }),
    ]);

    render(<NeedsAttentionSection />);

    expect(screen.getByText('First issue')).toBeInTheDocument();
    expect(screen.getByText('Second issue')).toBeInTheDocument();
    expect(screen.getByText('Third issue')).toBeInTheDocument();
  });

  it('renders description text for each item', () => {
    mockUseAttentionItems.mockReturnValue([
      makeItem({ description: 'Relay dead letters detected' }),
    ]);

    render(<NeedsAttentionSection />);

    expect(screen.getByText('Relay dead letters detected')).toBeInTheDocument();
  });

  it('renders action button for each item', () => {
    mockUseAttentionItems.mockReturnValue([
      makeItem({ action: { label: 'Open →', onClick: vi.fn() } }),
    ]);

    render(<NeedsAttentionSection />);

    expect(screen.getByRole('button', { name: 'Open →' })).toBeInTheDocument();
  });

  it('action button triggers onClick handler', () => {
    const onClick = vi.fn();
    mockUseAttentionItems.mockReturnValue([
      makeItem({ id: 'unique-item', action: { label: 'Unique Action →', onClick } }),
    ]);

    render(<NeedsAttentionSection />);

    fireEvent.click(screen.getByRole('button', { name: 'Unique Action →' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders timestamp for each item', () => {
    const timestamp = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
    mockUseAttentionItems.mockReturnValue([makeItem({ timestamp })]);

    render(<NeedsAttentionSection />);

    // Relative time should be rendered (e.g. "30m")
    expect(screen.getByText('30m')).toBeInTheDocument();
  });
});
