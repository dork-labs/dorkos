// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Mock useTheme
const mockSetTheme = vi.fn();
let mockTheme = 'light';
vi.mock('@/layers/shared/model/use-theme', () => ({
  useTheme: () => ({ theme: mockTheme, setTheme: mockSetTheme }),
}));

// Mock app-store
const mockSetSettingsOpen = vi.fn();
const mockToggleDevtools = vi.fn();
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: () => ({
    setSettingsOpen: mockSetSettingsOpen,
    devtoolsOpen: false,
    toggleDevtools: mockToggleDevtools,
  }),
}));

import { SidebarFooterBar } from '../ui/SidebarFooterBar';

describe('SidebarFooterBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTheme = 'light';
  });

  afterEach(() => {
    cleanup();
  });

  it('renders branding link with correct href, target, and rel', () => {
    render(<SidebarFooterBar />);

    const link = screen.getByRole('link');
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', 'https://dorkos.ai');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('calls setSettingsOpen(true) when settings button is clicked', () => {
    render(<SidebarFooterBar />);

    fireEvent.click(screen.getByLabelText('Settings'));
    expect(mockSetSettingsOpen).toHaveBeenCalledWith(true);
  });

  it('cycles theme from light to dark', () => {
    mockTheme = 'light';
    render(<SidebarFooterBar />);

    fireEvent.click(screen.getByLabelText(/Theme: light/));
    expect(mockSetTheme).toHaveBeenCalledWith('dark');
  });

  it('cycles theme from dark to system', () => {
    mockTheme = 'dark';
    render(<SidebarFooterBar />);

    fireEvent.click(screen.getByLabelText(/Theme: dark/));
    expect(mockSetTheme).toHaveBeenCalledWith('system');
  });

  it('cycles theme from system to light', () => {
    mockTheme = 'system';
    render(<SidebarFooterBar />);

    fireEvent.click(screen.getByLabelText(/Theme: system/));
    expect(mockSetTheme).toHaveBeenCalledWith('light');
  });

  it('displays the current theme in the toggle button aria-label', () => {
    mockTheme = 'dark';
    render(<SidebarFooterBar />);

    expect(screen.getByLabelText('Theme: dark. Click to cycle.')).toBeInTheDocument();
  });
});
