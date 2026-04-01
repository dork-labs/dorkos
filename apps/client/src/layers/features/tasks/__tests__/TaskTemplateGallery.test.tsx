/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { TaskTemplate } from '@dorkos/shared/types';
import { TaskTemplateGallery } from '../ui/TaskTemplateGallery';

const PRESETS: TaskTemplate[] = [
  {
    id: 'health-check',
    name: 'Health Check',
    description: 'Lint and test',
    prompt: 'Run checks',
    cron: '0 8 * * 1',
    timezone: 'UTC',
  },
  {
    id: 'docs-sync',
    name: 'Docs Sync',
    description: 'Sync docs',
    prompt: 'Review docs',
    cron: '0 10 * * *',
    timezone: 'UTC',
  },
];

// Mock useTaskTemplates at the entities/tasks barrel
const mockUseTaskTemplates = vi.fn();
vi.mock('@/layers/entities/tasks', () => ({
  useTaskTemplates: () => mockUseTaskTemplates(),
}));

// Mock TaskTemplateCard to a simple button for isolation
vi.mock('../ui/TaskTemplateCard', () => ({
  TaskTemplateCard: ({
    preset,
    onSelect,
    selected,
  }: {
    preset: TaskTemplate;
    onSelect?: (p: TaskTemplate) => void;
    selected?: boolean;
  }) => (
    <button
      data-testid={`card-${preset.id}`}
      data-selected={selected}
      onClick={() => onSelect?.(preset)}
    >
      {preset.name}
    </button>
  ),
}));

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('TaskTemplateGallery', () => {
  afterEach(() => {
    cleanup();
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows skeleton cards while loading', () => {
    mockUseTaskTemplates.mockReturnValue({ isLoading: true, isError: false, data: undefined });
    const { container } = render(<TaskTemplateGallery />, { wrapper: Wrapper });
    // 4 skeleton divs with animate-tasks
    const skeletons = container.querySelectorAll('.animate-tasks');
    expect(skeletons.length).toBe(4);
  });

  it('shows error message on error', () => {
    mockUseTaskTemplates.mockReturnValue({ isLoading: false, isError: true, data: undefined });
    render(<TaskTemplateGallery />, { wrapper: Wrapper });
    expect(screen.getByText(/Failed to load presets/i)).toBeTruthy();
  });

  it('renders a card for each preset', () => {
    mockUseTaskTemplates.mockReturnValue({ isLoading: false, isError: false, data: PRESETS });
    render(<TaskTemplateGallery />, { wrapper: Wrapper });
    expect(screen.getByTestId('card-health-check')).toBeTruthy();
    expect(screen.getByTestId('card-docs-sync')).toBeTruthy();
  });

  it('calls onSelect with the correct preset when a card is clicked', () => {
    mockUseTaskTemplates.mockReturnValue({ isLoading: false, isError: false, data: PRESETS });
    const onSelect = vi.fn();
    render(<TaskTemplateGallery onSelect={onSelect} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('card-health-check'));
    expect(onSelect).toHaveBeenCalledWith(PRESETS[0]);
  });

  it('passes selected=true to the card matching selectedId', () => {
    mockUseTaskTemplates.mockReturnValue({ isLoading: false, isError: false, data: PRESETS });
    render(<TaskTemplateGallery selectedId="docs-sync" />, { wrapper: Wrapper });
    expect(screen.getByTestId('card-docs-sync').getAttribute('data-selected')).toBe('true');
    expect(screen.getByTestId('card-health-check').getAttribute('data-selected')).toBe('false');
  });

  it('handles empty preset list gracefully', () => {
    mockUseTaskTemplates.mockReturnValue({ isLoading: false, isError: false, data: [] });
    render(<TaskTemplateGallery />, { wrapper: Wrapper });
    expect(screen.getByText(/No presets available/i)).toBeTruthy();
  });
});
