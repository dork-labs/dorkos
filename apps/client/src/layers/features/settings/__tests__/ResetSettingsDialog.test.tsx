// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ResetSettingsDialog } from '../ui/ResetSettingsDialog';
import { useAppStore, useThemeStore } from '@/layers/shared/model';

// Mock Radix AlertDialog portal to render inline (prevents document.body duplication)
vi.mock('@radix-ui/react-alert-dialog', async () => {
  const actual = await vi.importActual<typeof import('@radix-ui/react-alert-dialog')>(
    '@radix-ui/react-alert-dialog'
  );
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe('ResetSettingsDialog', () => {
  const onOpenChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useAppStore.getState().resetAllSettings();
    useThemeStore.getState().setTheme('system');
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('says what it resets and what it leaves alone', () => {
    render(<ResetSettingsDialog open onOpenChange={onOpenChange} />);
    expect(screen.getByText(/back to how they shipped/i)).toBeInTheDocument();
    expect(screen.getByText(/your projects, agents, and chats stay/i)).toBeInTheDocument();
  });

  it('resets nothing until the confirm is pressed', () => {
    useAppStore.getState().setShowTimestamps(true);
    useThemeStore.getState().setTheme('dark');

    render(<ResetSettingsDialog open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(useAppStore.getState().showTimestamps).toBe(true);
    expect(useThemeStore.getState().theme).toBe('dark');
  });

  it('confirming clears the cross-slice settings the Appearance reset must not touch', () => {
    useAppStore.getState().setShowTimestamps(true);
    useAppStore.getState().setSidebarActiveTab('connections');
    useAppStore.getState().setFontSize('large');
    useThemeStore.getState().setTheme('dark');

    render(<ResetSettingsDialog open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset Settings' }));

    const s = useAppStore.getState();
    expect(s.showTimestamps).toBe(false);
    expect(s.sidebarActiveTab).toBe('overview');
    expect(s.fontSize).toBe('medium');
    expect(useThemeStore.getState().theme).toBe('system');
    expect(localStorage.getItem('dorkos-show-timestamps')).toBeNull();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
