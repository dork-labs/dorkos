/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HealthBar } from '../ui/HealthBar';

// Mock the entity hooks so the component doesn't need a real server
vi.mock('@/layers/entities/roadmap-item', () => ({
  useRoadmapMeta: () => ({
    data: { projectName: 'Test Project', projectSummary: '', lastUpdated: new Date().toISOString(), timeHorizons: { now: { label: 'Now', description: '' }, next: { label: 'Next', description: '' }, later: { label: 'Later', description: '' } } },
    isLoading: false,
    isError: false,
  }),
}));

// Mock Zustand store
const mockSetEditingItemId = vi.fn();
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: { setEditingItemId: typeof mockSetEditingItemId }) => unknown) =>
    selector({ setEditingItemId: mockSetEditingItemId }),
}));

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={makeQueryClient()}>{children}</QueryClientProvider>
  );
}

const DEFAULT_PROPS = {
  totalItems: 20,
  mustHavePercent: 40,
  inProgressCount: 5,
  atRiskCount: 2,
  blockedCount: 1,
  completedCount: 8,
};

describe('HealthBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders project name from meta', () => {
    render(<HealthBar {...DEFAULT_PROPS} />, { wrapper: Wrapper });
    expect(screen.getByText('Test Project')).toBeInTheDocument();
  });

  it('renders all stat pills', () => {
    render(<HealthBar {...DEFAULT_PROPS} />, { wrapper: Wrapper });
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
  });

  it('does not show warning icon when must-have percent is at or below 60', () => {
    render(<HealthBar {...DEFAULT_PROPS} mustHavePercent={60} />, { wrapper: Wrapper });
    expect(screen.queryByLabelText('Must-have percentage is high')).not.toBeInTheDocument();
  });

  it('shows warning icon when must-have percent exceeds 60', () => {
    render(<HealthBar {...DEFAULT_PROPS} mustHavePercent={61} />, { wrapper: Wrapper });
    expect(screen.getByLabelText('Must-have percentage is high')).toBeInTheDocument();
  });

  it('calls setEditingItemId with "new" when New Item is clicked', () => {
    render(<HealthBar {...DEFAULT_PROPS} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('button', { name: /new item/i }));
    expect(mockSetEditingItemId).toHaveBeenCalledWith('new');
  });
});
