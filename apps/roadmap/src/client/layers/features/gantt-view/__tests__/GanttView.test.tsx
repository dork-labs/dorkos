/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GanttView } from '../ui/GanttView';
import type { RoadmapItem } from '@dorkos/shared/roadmap-schemas';

// --- Mock entity hooks ---
vi.mock('@/layers/entities/roadmap-item', () => ({
  useRoadmapItems: vi.fn(),
}));

// --- Mock app store ---
const mockSetEditingItemId = vi.fn();

vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { setEditingItemId: mockSetEditingItemId };
    return selector ? selector(state) : state;
  },
}));

// --- Test helpers ---

/** Build a minimal RoadmapItem with sensible defaults. */
function makeItem(overrides: Partial<RoadmapItem>): RoadmapItem {
  return {
    id: crypto.randomUUID(),
    title: 'Test item',
    type: 'feature',
    moscow: 'must-have',
    status: 'not-started',
    health: 'on-track',
    timeHorizon: 'now',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={makeQueryClient()}>{children}</QueryClientProvider>
  );
}

import { useRoadmapItems } from '@/layers/entities/roadmap-item';

describe('GanttView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state while items are loading', () => {
    vi.mocked(useRoadmapItems).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<GanttView />, { wrapper: Wrapper });

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows empty state when no items have date ranges', () => {
    vi.mocked(useRoadmapItems).mockReturnValue({
      data: [makeItem({ title: 'No dates here' })],
      isLoading: false,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<GanttView />, { wrapper: Wrapper });

    expect(
      screen.getByText(/No items with date ranges/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Add startDate and endDate to items to see them on the Gantt chart/i),
    ).toBeInTheDocument();
  });

  it('renders bars for items with both startDate and endDate', () => {
    const item = makeItem({
      title: 'Feature Alpha',
      status: 'in-progress',
      startDate: '2025-01-01T00:00:00.000Z',
      endDate: '2025-03-01T00:00:00.000Z',
    });

    vi.mocked(useRoadmapItems).mockReturnValue({
      data: [item],
      isLoading: false,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<GanttView />, { wrapper: Wrapper });

    expect(screen.getByText('Feature Alpha')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit Feature Alpha/i })).toBeInTheDocument();
  });

  it('excludes items missing startDate or endDate with a count', () => {
    const withDates = makeItem({
      title: 'Has Dates',
      startDate: '2025-01-01T00:00:00.000Z',
      endDate: '2025-06-01T00:00:00.000Z',
    });
    const noDates = makeItem({ title: 'No Dates' });
    const onlyStart = makeItem({
      title: 'Only Start',
      startDate: '2025-01-01T00:00:00.000Z',
    });

    vi.mocked(useRoadmapItems).mockReturnValue({
      data: [withDates, noDates, onlyStart],
      isLoading: false,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<GanttView />, { wrapper: Wrapper });

    // Only the item with both dates renders a bar
    expect(screen.getByText('Has Dates')).toBeInTheDocument();
    expect(screen.queryByText('No Dates')).not.toBeInTheDocument();
    expect(screen.queryByText('Only Start')).not.toBeInTheDocument();

    // Hidden count shown
    expect(screen.getByText(/2 items hidden/i)).toBeInTheDocument();
  });

  it('calls setEditingItemId when a bar is clicked', () => {
    const item = makeItem({
      id: 'test-id-123',
      title: 'Clickable Bar',
      startDate: '2025-01-01T00:00:00.000Z',
      endDate: '2025-04-01T00:00:00.000Z',
    });

    vi.mocked(useRoadmapItems).mockReturnValue({
      data: [item],
      isLoading: false,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<GanttView />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole('button', { name: /Edit Clickable Bar/i }));

    expect(mockSetEditingItemId).toHaveBeenCalledWith('test-id-123');
  });

  it('renders multiple items with date ranges as separate rows', () => {
    const items = [
      makeItem({
        title: 'Alpha',
        startDate: '2025-01-01T00:00:00.000Z',
        endDate: '2025-03-01T00:00:00.000Z',
      }),
      makeItem({
        title: 'Beta',
        startDate: '2025-02-01T00:00:00.000Z',
        endDate: '2025-05-01T00:00:00.000Z',
      }),
    ];

    vi.mocked(useRoadmapItems).mockReturnValue({
      data: items,
      isLoading: false,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<GanttView />, { wrapper: Wrapper });

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
});
