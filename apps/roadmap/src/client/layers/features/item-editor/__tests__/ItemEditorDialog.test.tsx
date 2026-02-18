// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ItemEditorDialog } from '../ui/ItemEditorDialog';

// === Mocks ===

// Mock the Zustand app store so we can control editingItemId
const mockSetEditingItemId = vi.fn();
let mockEditingItemId: string | null = null;

vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: { editingItemId: string | null; setEditingItemId: typeof mockSetEditingItemId }) => unknown) =>
    selector({ editingItemId: mockEditingItemId, setEditingItemId: mockSetEditingItemId }),
}));

// Mock entity hooks
const mockCreateMutate = vi.fn();
const mockUpdateMutate = vi.fn();
const mockDeleteMutate = vi.fn();

vi.mock('@/layers/entities/roadmap-item', () => ({
  useRoadmapItems: () => ({
    data: [
      {
        id: 'existing-uuid-1234',
        title: 'Existing Item',
        type: 'feature',
        moscow: 'must-have',
        status: 'not-started',
        health: 'on-track',
        timeHorizon: 'now',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ],
  }),
  useCreateItem: () => ({
    mutate: mockCreateMutate,
    isPending: false,
  }),
  useUpdateItem: () => ({
    mutate: mockUpdateMutate,
    isPending: false,
  }),
  useDeleteItem: () => ({
    mutate: mockDeleteMutate,
    isPending: false,
  }),
}));

// === Test helpers ===

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

// === Tests ===

describe('ItemEditorDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when editingItemId is null', () => {
    mockEditingItemId = null;
    const { container } = render(<ItemEditorDialog />, { wrapper: createWrapper() });
    expect(container.firstChild).toBeNull();
  });

  it('renders dialog when editingItemId is set to "new"', () => {
    mockEditingItemId = 'new';
    render(<ItemEditorDialog />, { wrapper: createWrapper() });
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('shows "New Item" title in create mode', () => {
    mockEditingItemId = 'new';
    render(<ItemEditorDialog />, { wrapper: createWrapper() });
    expect(screen.getByText('New Item')).toBeDefined();
  });

  it('shows "Edit Item" title in edit mode', () => {
    mockEditingItemId = 'existing-uuid-1234';
    render(<ItemEditorDialog />, { wrapper: createWrapper() });
    expect(screen.getByText('Edit Item')).toBeDefined();
  });

  it('does not show Delete button in create mode', () => {
    mockEditingItemId = 'new';
    render(<ItemEditorDialog />, { wrapper: createWrapper() });
    expect(screen.queryByText('Delete')).toBeNull();
  });

  it('shows Delete button in edit mode', () => {
    mockEditingItemId = 'existing-uuid-1234';
    render(<ItemEditorDialog />, { wrapper: createWrapper() });
    expect(screen.getByText('Delete')).toBeDefined();
  });

  it('disables submit button when title is empty', () => {
    mockEditingItemId = 'new';
    render(<ItemEditorDialog />, { wrapper: createWrapper() });
    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect(saveButton).toBeDisabled();
  });

  it('renders title input in the form', () => {
    mockEditingItemId = 'new';
    render(<ItemEditorDialog />, { wrapper: createWrapper() });
    expect(screen.getByLabelText(/title/i)).toBeDefined();
  });

  it('pre-fills title when editing existing item', () => {
    mockEditingItemId = 'existing-uuid-1234';
    render(<ItemEditorDialog />, { wrapper: createWrapper() });
    const titleInput = screen.getByDisplayValue('Existing Item');
    expect(titleInput).toBeDefined();
  });
});
