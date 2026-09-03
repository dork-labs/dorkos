/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useAppStore } from '@/layers/shared/model';
import { ShortcutsPanel } from '../ui/ShortcutsPanel';

// Mock ResponsiveDialog to render children directly when open
vi.mock('@/layers/shared/ui', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/ui');
  return {
    ...actual,
    ResponsiveDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
      open ? <div data-testid="dialog">{children}</div> : null,
    ResponsiveDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ResponsiveDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ResponsiveDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    ResponsiveDialogBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Kbd: ({ children }: { children: React.ReactNode }) => <kbd>{children}</kbd>,
  };
});

describe('ShortcutsPanel', () => {
  beforeEach(() => {
    useAppStore.setState({ shortcutsPanelOpen: false });
  });

  afterEach(() => {
    cleanup();
  });

  it('does not render when shortcutsPanelOpen is false', () => {
    render(<ShortcutsPanel />);
    expect(screen.queryByTestId('dialog')).not.toBeInTheDocument();
  });

  it('renders all shortcut groups when open', () => {
    useAppStore.setState({ shortcutsPanelOpen: true });
    render(<ShortcutsPanel />);

    expect(screen.getByText('Navigation')).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.getByText('Global')).toBeInTheDocument();
  });

  it('displays shortcut labels and formatted keys', () => {
    useAppStore.setState({ shortcutsPanelOpen: true });
    render(<ShortcutsPanel />);

    expect(screen.getByText('Command palette')).toBeInTheDocument();
    expect(screen.getByText('Toggle sidebar')).toBeInTheDocument();
    // Two of these on screen since the dialog title dropped its Title Case
    // (DOR-1755): the heading, and the row for the shortcut that opens it.
    expect(screen.getAllByText('Keyboard shortcuts')).toHaveLength(2);
  });

  it('renders the dialog title', () => {
    useAppStore.setState({ shortcutsPanelOpen: true });
    render(<ShortcutsPanel />);

    expect(screen.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });
});
