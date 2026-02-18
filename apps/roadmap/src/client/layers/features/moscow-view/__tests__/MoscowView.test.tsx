/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MoscowView } from '../ui/MoscowView';
import type { RoadmapItem } from '@dorkos/shared/roadmap-schemas';

// Mock @hello-pangea/dnd — render children without drag infrastructure
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

// Mock roadmap entity hooks
const mockMutate = vi.fn();

vi.mock('@/layers/entities/roadmap-item', () => ({
  useRoadmapItems: vi.fn(),
  useUpdateItem: () => ({ mutate: mockMutate }),
  useReorderItems: () => ({ mutate: mockMutate }),
}));

// Mock zustand app-store to avoid localStorage issues
const mockSetEditingItemId = vi.fn();

vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { setEditingItemId: mockSetEditingItemId };
    return selector ? selector(state) : state;
  },
}));

// Import mocked hook for per-test configuration
import { useRoadmapItems } from '@/layers/entities/roadmap-item';

/** Build a minimal RoadmapItem with sensible defaults. */
function makeItem(overrides: Partial<RoadmapItem> = {}): RoadmapItem {
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

describe('MoscowView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all four MoSCoW column headings', () => {
    vi.mocked(useRoadmapItems).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<MoscowView />, { wrapper: Wrapper });

    expect(screen.getByText('Must Have')).toBeInTheDocument();
    expect(screen.getByText('Should Have')).toBeInTheDocument();
    expect(screen.getByText('Could Have')).toBeInTheDocument();
    expect(screen.getByText("Won't Have")).toBeInTheDocument();
  });

  it('applies green color class to Must Have column', () => {
    vi.mocked(useRoadmapItems).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<MoscowView />, { wrapper: Wrapper });

    const mustHaveHeading = screen.getByText('Must Have');
    expect(mustHaveHeading.className).toContain('text-green-600');
  });

  it('applies blue color class to Should Have column', () => {
    vi.mocked(useRoadmapItems).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<MoscowView />, { wrapper: Wrapper });

    const shouldHaveHeading = screen.getByText('Should Have');
    expect(shouldHaveHeading.className).toContain('text-blue-600');
  });

  it('applies amber color class to Could Have column', () => {
    vi.mocked(useRoadmapItems).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<MoscowView />, { wrapper: Wrapper });

    const couldHaveHeading = screen.getByText('Could Have');
    expect(couldHaveHeading.className).toContain('text-amber-600');
  });

  it("applies gray color class to Won't Have column", () => {
    vi.mocked(useRoadmapItems).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<MoscowView />, { wrapper: Wrapper });

    const wontHaveHeading = screen.getByText("Won't Have");
    expect(wontHaveHeading.className).toContain('text-gray-500');
  });

  it('shows a loading state when items are loading', () => {
    vi.mocked(useRoadmapItems).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as ReturnType<typeof useRoadmapItems>);

    render(<MoscowView />, { wrapper: Wrapper });

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows an error state when the query fails', () => {
    vi.mocked(useRoadmapItems).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Network error'),
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<MoscowView />, { wrapper: Wrapper });

    expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
  });

  it('places items in their correct columns', () => {
    const mustItem = makeItem({ title: 'Must Have Item', moscow: 'must-have' });
    const shouldItem = makeItem({ title: 'Should Have Item', moscow: 'should-have' });
    const couldItem = makeItem({ title: 'Could Have Item', moscow: 'could-have' });
    const wontItem = makeItem({ title: "Won't Have Item", moscow: 'wont-have' });

    vi.mocked(useRoadmapItems).mockReturnValue({
      data: [mustItem, shouldItem, couldItem, wontItem],
      isLoading: false,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<MoscowView />, { wrapper: Wrapper });

    expect(screen.getByText('Must Have Item')).toBeInTheDocument();
    expect(screen.getByText('Should Have Item')).toBeInTheDocument();
    expect(screen.getByText('Could Have Item')).toBeInTheDocument();
    expect(screen.getByText("Won't Have Item")).toBeInTheDocument();
  });

  it('shows empty columns with count 0 when no items match', () => {
    vi.mocked(useRoadmapItems).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<MoscowView />, { wrapper: Wrapper });

    // All four columns should show 0
    const zeroBadges = screen.getAllByText('0');
    expect(zeroBadges).toHaveLength(4);
  });

  it('shows correct item counts in column badges', () => {
    const items = [
      makeItem({ moscow: 'must-have' }),
      makeItem({ moscow: 'must-have' }),
      makeItem({ moscow: 'should-have' }),
    ];

    vi.mocked(useRoadmapItems).mockReturnValue({
      data: items,
      isLoading: false,
    } as unknown as ReturnType<typeof useRoadmapItems>);

    render(<MoscowView />, { wrapper: Wrapper });

    // Two must-have items
    const twoBadges = screen.getAllByText('2');
    expect(twoBadges.length).toBeGreaterThanOrEqual(1);

    // One should-have item
    const oneBadges = screen.getAllByText('1');
    expect(oneBadges.length).toBeGreaterThanOrEqual(1);
  });
});
