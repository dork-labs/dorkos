/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KanbanView } from '../ui/KanbanView';
import type { RoadmapItem } from '@dorkos/shared/roadmap-schemas';

// --- Mock @hello-pangea/dnd ---
// Render children directly without actual DnD context so tests stay simple
vi.mock('@hello-pangea/dnd', () => ({
  DragDropContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Droppable: ({
    children,
    droppableId,
  }: {
    children: (provided: unknown, snapshot: unknown) => React.ReactNode;
    droppableId: string;
  }) =>
    children(
      { innerRef: () => {}, droppableProps: { 'data-droppable-id': droppableId }, placeholder: null },
      { isDraggingOver: false },
    ),
  Draggable: ({
    children,
  }: {
    children: (provided: unknown, snapshot: unknown) => React.ReactNode;
  }) =>
    children(
      {
        innerRef: () => {},
        draggableProps: {},
        dragHandleProps: {},
      },
      { isDragging: false },
    ),
}));

// --- Mock entity hooks ---
const mockMutate = vi.fn();

vi.mock('@/layers/entities/roadmap-item', () => ({
  useRoadmapItems: vi.fn(),
  useUpdateItem: () => ({ mutate: mockMutate }),
  useReorderItems: () => ({ mutate: mockMutate }),
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

// Import the mocked hook for configuration in each test
import { useRoadmapItems } from '@/layers/entities/roadmap-item';

describe('KanbanView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all four column headers', () => {
    vi.mocked(useRoadmapItems).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<KanbanView />, { wrapper: Wrapper });

    expect(screen.getByText('Not Started')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('On Hold')).toBeInTheDocument();
  });

  it('shows a loading state when items are loading', () => {
    vi.mocked(useRoadmapItems).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<KanbanView />, { wrapper: Wrapper });

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    // No column headers while loading
    expect(screen.queryByText('Not Started')).not.toBeInTheDocument();
  });

  it('sorts items into the correct columns', () => {
    const notStarted = makeItem({ title: 'Plan feature', status: 'not-started' });
    const inProgress = makeItem({ title: 'Build it', status: 'in-progress' });
    const completed = makeItem({ title: 'Shipped!', status: 'completed' });
    const onHold = makeItem({ title: 'Paused work', status: 'on-hold' });

    vi.mocked(useRoadmapItems).mockReturnValue({
      data: [notStarted, inProgress, completed, onHold],
      isLoading: false,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<KanbanView />, { wrapper: Wrapper });

    expect(screen.getByText('Plan feature')).toBeInTheDocument();
    expect(screen.getByText('Build it')).toBeInTheDocument();
    expect(screen.getByText('Shipped!')).toBeInTheDocument();
    expect(screen.getByText('Paused work')).toBeInTheDocument();
  });

  it('displays item count badge for each column', () => {
    const items = [
      makeItem({ status: 'not-started' }),
      makeItem({ status: 'not-started' }),
      makeItem({ status: 'in-progress' }),
    ];

    vi.mocked(useRoadmapItems).mockReturnValue({
      data: items,
      isLoading: false,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<KanbanView />, { wrapper: Wrapper });

    // Two not-started items
    const countBadges = screen.getAllByText('2');
    expect(countBadges.length).toBeGreaterThanOrEqual(1);

    // One in-progress item
    const singleBadge = screen.getAllByText('1');
    expect(singleBadge.length).toBeGreaterThanOrEqual(1);
  });

  it('shows empty columns (count 0) when no items match that status', () => {
    vi.mocked(useRoadmapItems).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<KanbanView />, { wrapper: Wrapper });

    // All four columns show 0 count
    const zeroBadges = screen.getAllByText('0');
    expect(zeroBadges).toHaveLength(4);
  });

  it('renders type and moscow badges on each card', () => {
    const item = makeItem({
      title: 'My feature card',
      type: 'feature',
      moscow: 'should-have',
      status: 'in-progress',
    });

    vi.mocked(useRoadmapItems).mockReturnValue({
      data: [item],
      isLoading: false,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<KanbanView />, { wrapper: Wrapper });

    expect(screen.getByText('My feature card')).toBeInTheDocument();
    expect(screen.getByText('Feature')).toBeInTheDocument();
    expect(screen.getByText('Should')).toBeInTheDocument();
  });
});
