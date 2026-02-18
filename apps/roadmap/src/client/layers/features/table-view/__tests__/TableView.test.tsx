/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RoadmapItem } from '@dorkos/shared/roadmap-schemas';
import { TableView } from '../ui/TableView';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_ITEMS: RoadmapItem[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Alpha feature',
    type: 'feature',
    moscow: 'must-have',
    status: 'in-progress',
    health: 'on-track',
    timeHorizon: 'now',
    effort: 3,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-10T00:00:00.000Z',
    dependencies: [],
    labels: [],
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    title: 'Beta bugfix',
    type: 'bugfix',
    moscow: 'should-have',
    status: 'not-started',
    health: 'at-risk',
    timeHorizon: 'next',
    effort: 1,
    createdAt: '2025-01-02T00:00:00.000Z',
    updatedAt: '2025-01-11T00:00:00.000Z',
    dependencies: [],
    labels: [],
  },
];

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockSetEditingItemId = vi.fn();

vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: { setEditingItemId: typeof mockSetEditingItemId }) => unknown) =>
    selector({ setEditingItemId: mockSetEditingItemId }),
}));

const mockUseRoadmapItems = vi.fn();
vi.mock('@/layers/entities/roadmap-item', () => ({
  useRoadmapItems: () => mockUseRoadmapItems(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={makeQueryClient()}>{children}</QueryClientProvider>
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TableView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRoadmapItems.mockReturnValue({
      data: MOCK_ITEMS,
      isLoading: false,
      isError: false,
    });
  });

  it('renders a row for each item', () => {
    render(<TableView />, { wrapper: Wrapper });
    expect(screen.getByText('Alpha feature')).toBeInTheDocument();
    expect(screen.getByText('Beta bugfix')).toBeInTheDocument();
  });

  it('renders column headers', () => {
    render(<TableView />, { wrapper: Wrapper });
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('MoSCoW')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Health')).toBeInTheDocument();
  });

  it('renders badge for type', () => {
    render(<TableView />, { wrapper: Wrapper });
    expect(screen.getByText('feature')).toBeInTheDocument();
    expect(screen.getByText('bugfix')).toBeInTheDocument();
  });

  it('calls setEditingItemId with item id when row is clicked', () => {
    render(<TableView />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('button', { name: /Edit Alpha feature/i }));
    expect(mockSetEditingItemId).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
  });

  it('shows loading state', () => {
    mockUseRoadmapItems.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });
    render(<TableView />, { wrapper: Wrapper });
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows error state', () => {
    mockUseRoadmapItems.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    render(<TableView />, { wrapper: Wrapper });
    expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
  });

  it('filters items by global filter input', () => {
    render(<TableView />, { wrapper: Wrapper });

    const filterInput = screen.getByRole('searchbox', { name: /filter roadmap items/i });
    fireEvent.change(filterInput, { target: { value: 'Alpha' } });

    expect(screen.getByText('Alpha feature')).toBeInTheDocument();
    expect(screen.queryByText('Beta bugfix')).not.toBeInTheDocument();
  });

  it('shows empty message when no items match filter', () => {
    render(<TableView />, { wrapper: Wrapper });

    const filterInput = screen.getByRole('searchbox', { name: /filter roadmap items/i });
    fireEvent.change(filterInput, { target: { value: 'zzznomatch' } });

    expect(screen.getByText(/no items match/i)).toBeInTheDocument();
  });
});
