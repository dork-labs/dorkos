// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@/layers/shared/ui';
import type { RightPanelContribution } from '@/layers/shared/model';
import { RightPanelTabBar } from '../ui/RightPanelTabBar';

// Minimal LucideIcon stub
const PanelRight = () => <svg data-testid="icon-panel-right" />;
const FileText = () => <svg data-testid="icon-file-text" />;

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const makeContributions = (): RightPanelContribution[] => [
  {
    id: 'canvas',
    title: 'Canvas',
    icon: PanelRight as unknown as RightPanelContribution['icon'],
    component: () => null,
    priority: 20,
  },
  {
    id: 'notes',
    title: 'Notes',
    icon: FileText as unknown as RightPanelContribution['icon'],
    component: () => null,
    priority: 30,
  },
];

function Wrapper({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

function renderTabBar(props: Partial<Parameters<typeof RightPanelTabBar>[0]> = {}) {
  const defaultProps = {
    contributions: makeContributions(),
    activeTab: 'canvas',
    onTabChange: vi.fn(),
    ...props,
  };
  return render(<RightPanelTabBar {...defaultProps} />, { wrapper: Wrapper });
}

describe('RightPanelTabBar', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders one button per contribution', () => {
    renderTabBar();
    expect(screen.getByRole('button', { name: 'Canvas' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notes' })).toBeInTheDocument();
  });

  it('sets aria-pressed="true" on the active tab only', () => {
    renderTabBar({ activeTab: 'canvas' });
    const canvasBtn = screen.getByRole('button', { name: 'Canvas' });
    const notesBtn = screen.getByRole('button', { name: 'Notes' });

    expect(canvasBtn).toHaveAttribute('aria-pressed', 'true');
    expect(notesBtn).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls onTabChange with the contribution ID when a tab is clicked', async () => {
    const onTabChange = vi.fn();
    const user = userEvent.setup();
    renderTabBar({ activeTab: 'canvas', onTabChange });

    await user.click(screen.getByRole('button', { name: 'Notes' }));
    expect(onTabChange).toHaveBeenCalledWith('notes');
    expect(onTabChange).toHaveBeenCalledTimes(1);
  });

  it('applies active styling classes to the active tab and inactive to others', () => {
    renderTabBar({ activeTab: 'notes' });
    const canvasBtn = screen.getByRole('button', { name: 'Canvas' });
    const notesBtn = screen.getByRole('button', { name: 'Notes' });

    // Active tab should have bg-accent and text-accent-foreground
    expect(notesBtn.className).toContain('bg-accent');
    expect(notesBtn.className).toContain('text-accent-foreground');

    // Inactive tab should have text-muted-foreground
    expect(canvasBtn.className).toContain('text-muted-foreground');
    expect(canvasBtn.className).not.toContain('bg-accent');
  });
});
