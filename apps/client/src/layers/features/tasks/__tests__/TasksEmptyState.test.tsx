// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { TaskTemplate } from '@dorkos/shared/types';
import { TasksEmptyState } from '../ui/TasksEmptyState';

const PRESETS: TaskTemplate[] = [
  {
    id: 'health-check',
    name: 'Health Check',
    description: 'Desc',
    prompt: 'Prompt',
    cron: '0 8 * * 1',
    timezone: 'UTC',
  },
];

vi.mock('@/layers/entities/tasks', () => ({
  useTaskTemplates: () => ({ data: PRESETS, isLoading: false, isError: false }),
}));

vi.mock('../ui/TaskTemplateGallery', () => ({
  TaskTemplateGallery: ({ onSelect }: { onSelect?: (p: TaskTemplate) => void }) => (
    <button onClick={() => onSelect?.(PRESETS[0])}>Health Check</button>
  ),
}));

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient();
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('TasksEmptyState', () => {
  afterEach(() => {
    cleanup();
  });

  it('calls onCreateWithPreset when a preset card is clicked', () => {
    const onCreateWithPreset = vi.fn();
    render(<TasksEmptyState onCreateWithPreset={onCreateWithPreset} onCreateBlank={vi.fn()} />, {
      wrapper: Wrapper,
    });
    fireEvent.click(screen.getByText('Health Check'));
    expect(onCreateWithPreset).toHaveBeenCalledWith(PRESETS[0]);
  });

  it('calls onCreateBlank when "New custom schedule" is clicked', () => {
    const onCreateBlank = vi.fn();
    render(<TasksEmptyState onCreateWithPreset={vi.fn()} onCreateBlank={onCreateBlank} />, {
      wrapper: Wrapper,
    });
    fireEvent.click(screen.getByText('New custom schedule'));
    expect(onCreateBlank).toHaveBeenCalled();
  });

  it('renders heading and description', () => {
    render(<TasksEmptyState onCreateWithPreset={vi.fn()} onCreateBlank={vi.fn()} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('No schedules yet.')).toBeTruthy();
    expect(screen.getByText(/Automate your workflows/i)).toBeTruthy();
  });
});
