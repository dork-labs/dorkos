/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { PulsePreset } from '@dorkos/shared/types';
import { PresetGallery } from '../ui/PresetGallery';

const PRESETS: PulsePreset[] = [
  {
    id: 'health-check',
    name: 'Health Check',
    description: 'Lint and test',
    prompt: 'Run checks',
    cron: '0 8 * * 1',
    timezone: 'UTC',
    category: 'maintenance',
  },
  {
    id: 'docs-sync',
    name: 'Docs Sync',
    description: 'Sync docs',
    prompt: 'Review docs',
    cron: '0 10 * * *',
    timezone: 'UTC',
    category: 'documentation',
  },
];

// Mock usePulsePresets at the entities/pulse barrel
const mockUsePulsePresets = vi.fn();
vi.mock('@/layers/entities/pulse', () => ({
  usePulsePresets: () => mockUsePulsePresets(),
}));

// Mock PresetCard to a simple button for isolation
vi.mock('../ui/PresetCard', () => ({
  PresetCard: ({
    preset,
    onSelect,
    selected,
  }: {
    preset: PulsePreset;
    onSelect?: (p: PulsePreset) => void;
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

describe('PresetGallery', () => {
  afterEach(() => {
    cleanup();
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows skeleton cards while loading', () => {
    mockUsePulsePresets.mockReturnValue({ isLoading: true, isError: false, data: undefined });
    const { container } = render(<PresetGallery />, { wrapper: Wrapper });
    // 4 skeleton divs with animate-pulse
    const skeletons = container.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBe(4);
  });

  it('shows error message on error', () => {
    mockUsePulsePresets.mockReturnValue({ isLoading: false, isError: true, data: undefined });
    render(<PresetGallery />, { wrapper: Wrapper });
    expect(screen.getByText(/Failed to load presets/i)).toBeTruthy();
  });

  it('renders a card for each preset', () => {
    mockUsePulsePresets.mockReturnValue({ isLoading: false, isError: false, data: PRESETS });
    render(<PresetGallery />, { wrapper: Wrapper });
    expect(screen.getByTestId('card-health-check')).toBeTruthy();
    expect(screen.getByTestId('card-docs-sync')).toBeTruthy();
  });

  it('calls onSelect with the correct preset when a card is clicked', () => {
    mockUsePulsePresets.mockReturnValue({ isLoading: false, isError: false, data: PRESETS });
    const onSelect = vi.fn();
    render(<PresetGallery onSelect={onSelect} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('card-health-check'));
    expect(onSelect).toHaveBeenCalledWith(PRESETS[0]);
  });

  it('passes selected=true to the card matching selectedId', () => {
    mockUsePulsePresets.mockReturnValue({ isLoading: false, isError: false, data: PRESETS });
    render(<PresetGallery selectedId="docs-sync" />, { wrapper: Wrapper });
    expect(screen.getByTestId('card-docs-sync').getAttribute('data-selected')).toBe('true');
    expect(screen.getByTestId('card-health-check').getAttribute('data-selected')).toBe('false');
  });

  it('handles empty preset list gracefully', () => {
    mockUsePulsePresets.mockReturnValue({ isLoading: false, isError: false, data: [] });
    render(<PresetGallery />, { wrapper: Wrapper });
    expect(screen.getByText(/No presets available/i)).toBeTruthy();
  });
});
