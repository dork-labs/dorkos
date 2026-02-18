/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { App } from '../App';

// Mock motion/react to avoid animation complexity in tests
vi.mock('motion/react', () => ({
  MotionConfig: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock the entity hooks
vi.mock('@/layers/entities/roadmap-item', () => ({
  useRoadmapItems: () => ({
    data: [],
    isLoading: false,
    isError: false,
  }),
  useRoadmapMeta: () => ({
    data: {
      projectName: 'Test Project',
      projectSummary: '',
      lastUpdated: new Date().toISOString(),
      timeHorizons: {
        now: { label: 'Now', description: '' },
        next: { label: 'Next', description: '' },
        later: { label: 'Later', description: '' },
      },
    },
    isLoading: false,
    isError: false,
  }),
}));

// Mock the app store and useTheme
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      viewMode: 'table',
      setViewMode: vi.fn(),
      editingItemId: null,
      setEditingItemId: vi.fn(),
      viewingSpecPath: null,
      setViewingSpecPath: vi.fn(),
      theme: 'system',
      setTheme: vi.fn(),
    }),
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}));

// Mock the health-bar feature
vi.mock('@/layers/features/health-bar', () => ({
  HealthBar: (props: { totalItems: number }) => (
    <div data-testid="health-bar">HealthBar ({props.totalItems} items)</div>
  ),
  ViewTabs: () => <div data-testid="view-tabs">ViewTabs</div>,
  ThemeToggle: () => <div data-testid="theme-toggle">ThemeToggle</div>,
  useHealthStats: () => ({
    totalItems: 0,
    mustHavePercent: 0,
    inProgressCount: 0,
    atRiskCount: 0,
    blockedCount: 0,
    completedCount: 0,
  }),
}));

// Mock the view features
vi.mock('@/layers/features/table-view', () => ({
  TableView: () => <div data-testid="table-view">TableView</div>,
}));

vi.mock('@/layers/features/kanban-view', () => ({
  KanbanView: () => <div data-testid="kanban-view">KanbanView</div>,
}));

vi.mock('@/layers/features/moscow-view', () => ({
  MoscowView: () => <div data-testid="moscow-view">MoscowView</div>,
}));

vi.mock('@/layers/features/gantt-view', () => ({
  GanttView: () => <div data-testid="gantt-view">GanttView</div>,
}));

// Mock the dialog features
vi.mock('@/layers/features/item-editor', () => ({
  ItemEditorDialog: () => null,
}));

vi.mock('@/layers/features/spec-viewer', () => ({
  SpecViewerDialog: () => null,
}));

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    render(<App />);
    expect(screen.getByTestId('health-bar')).toBeInTheDocument();
    expect(screen.getByTestId('view-tabs')).toBeInTheDocument();
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
  });

  it('renders the table view by default', () => {
    render(<App />);
    expect(screen.getByTestId('table-view')).toBeInTheDocument();
  });
});
