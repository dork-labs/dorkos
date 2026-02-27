/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { AdapterCard } from '../ui/AdapterCard';
import type { AdapterManifest, CatalogInstance } from '@dorkos/shared/relay-schemas';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseManifest: AdapterManifest = {
  type: 'telegram',
  displayName: 'Telegram',
  description: 'Telegram messaging adapter',
  iconEmoji: '📨',
  category: 'messaging',
  builtin: false,
  configFields: [],
  multiInstance: false,
};

const claudeManifest: AdapterManifest = {
  type: 'claude-code',
  displayName: 'Claude Code',
  description: 'Built-in Claude Code adapter',
  iconEmoji: '🤖',
  category: 'internal',
  builtin: true,
  configFields: [],
  multiInstance: false,
};

const connectedInstance: CatalogInstance = {
  id: 'tg-main',
  enabled: true,
  status: {
    id: 'tg-main',
    type: 'telegram',
    displayName: 'Main Telegram',
    state: 'connected',
    messageCount: { inbound: 42, outbound: 18 },
    errorCount: 0,
  },
};

const errorInstance: CatalogInstance = {
  id: 'tg-err',
  enabled: true,
  status: {
    id: 'tg-err',
    type: 'telegram',
    displayName: 'Error Telegram',
    state: 'error',
    messageCount: { inbound: 5, outbound: 0 },
    errorCount: 3,
    lastError: 'Connection timed out',
  },
};

const disabledInstance: CatalogInstance = {
  id: 'tg-disabled',
  enabled: false,
  status: {
    id: 'tg-disabled',
    type: 'telegram',
    displayName: 'Disabled Telegram',
    state: 'disconnected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  },
};

const claudeInstance: CatalogInstance = {
  id: 'claude-code',
  enabled: true,
  status: {
    id: 'claude-code',
    type: 'claude-code',
    displayName: 'Claude Code',
    state: 'connected',
    messageCount: { inbound: 10, outbound: 5 },
    errorCount: 0,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultProps(overrides: Partial<Parameters<typeof AdapterCard>[0]> = {}) {
  return {
    instance: connectedInstance,
    manifest: baseManifest,
    onToggle: vi.fn(),
    onConfigure: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
}

/** Opens the Radix DropdownMenu trigger using the full pointer sequence required in jsdom. */
async function openKebabMenu() {
  const trigger = screen.getByLabelText('Adapter actions');
  await act(async () => {
    fireEvent.pointerDown(trigger);
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdapterCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the adapter display name', () => {
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.getByText('Main Telegram')).toBeTruthy();
  });

  it('renders the category badge', () => {
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.getByText('messaging')).toBeTruthy();
  });

  it('renders the icon emoji', () => {
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.getByText('📨')).toBeTruthy();
  });

  it('shows a green dot for connected state', () => {
    const { container } = render(<AdapterCard {...defaultProps()} />);
    const dot = container.querySelector('.bg-green-500');
    expect(dot).toBeTruthy();
  });

  it('shows a red dot for error state', () => {
    const { container } = render(
      <AdapterCard {...defaultProps({ instance: errorInstance })} />,
    );
    const dot = container.querySelector('.bg-red-500');
    expect(dot).toBeTruthy();
  });

  it('shows a gray dot for disconnected state', () => {
    const { container } = render(
      <AdapterCard {...defaultProps({ instance: disabledInstance })} />,
    );
    const dot = container.querySelector('.bg-gray-400');
    expect(dot).toBeTruthy();
  });

  it('displays inbound and outbound message counts', () => {
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.getByText(/In: 42/)).toBeTruthy();
    expect(screen.getByText(/Out: 18/)).toBeTruthy();
  });

  it('does not show error count when errorCount is 0', () => {
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.queryByText(/Errors:/)).toBeNull();
  });

  it('shows error count when errorCount is greater than 0', () => {
    render(<AdapterCard {...defaultProps({ instance: errorInstance })} />);
    expect(screen.getByText(/Errors: 3/)).toBeTruthy();
  });

  it('shows lastError message when present', () => {
    render(<AdapterCard {...defaultProps({ instance: errorInstance })} />);
    expect(screen.getByText('Connection timed out')).toBeTruthy();
  });

  it('renders switch in checked state when adapter is enabled', () => {
    render(<AdapterCard {...defaultProps()} />);
    const switchEl = screen.getByRole('switch');
    expect(switchEl.getAttribute('data-state')).toBe('checked');
  });

  it('renders switch in unchecked state when adapter is disabled', () => {
    render(<AdapterCard {...defaultProps({ instance: disabledInstance })} />);
    const switchEl = screen.getByRole('switch');
    expect(switchEl.getAttribute('data-state')).toBe('unchecked');
  });

  it('calls onToggle with true when switch is clicked while disabled', () => {
    const onToggle = vi.fn();
    render(<AdapterCard {...defaultProps({ instance: disabledInstance, onToggle })} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('calls onToggle with false when switch is clicked while enabled', () => {
    const onToggle = vi.fn();
    render(<AdapterCard {...defaultProps({ onToggle })} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('falls back to instance id when displayName is empty', () => {
    const noNameInstance: CatalogInstance = {
      ...connectedInstance,
      status: { ...connectedInstance.status, displayName: '' },
    };
    render(<AdapterCard {...defaultProps({ instance: noNameInstance })} />);
    expect(screen.getByText('tg-main')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Kebab menu tests
  // -------------------------------------------------------------------------

  it('opens kebab menu when clicking the actions button', async () => {
    render(<AdapterCard {...defaultProps()} />);

    await openKebabMenu();

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /Configure/i })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: /Remove/i })).toBeTruthy();
    });
  });

  it('calls onConfigure when Configure menu item is clicked', async () => {
    const onConfigure = vi.fn();
    render(<AdapterCard {...defaultProps({ onConfigure })} />);

    await openKebabMenu();

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /Configure/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Configure/i }));
    });

    expect(onConfigure).toHaveBeenCalledTimes(1);
  });

  it('opens confirmation dialog when Remove menu item is clicked', async () => {
    render(<AdapterCard {...defaultProps()} />);

    await openKebabMenu();

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /Remove/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Remove/i }));
    });

    await waitFor(() => {
      expect(screen.getByText('Remove adapter')).toBeTruthy();
      expect(screen.getByText(/Are you sure you want to remove/)).toBeTruthy();
    });
  });

  it('calls onRemove when confirmation dialog is confirmed', async () => {
    const onRemove = vi.fn();
    render(<AdapterCard {...defaultProps({ onRemove })} />);

    await openKebabMenu();

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /Remove/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Remove/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeTruthy();
    });

    // Find the confirm "Remove" button inside the alert dialog.
    const dialog = screen.getByRole('alertdialog');
    const buttons = dialog.querySelectorAll('button');
    // AlertDialogFooter order: Cancel, then Action (Remove)
    const confirmBtn = buttons[buttons.length - 1];

    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('disables Remove for built-in claude-code adapter', async () => {
    render(
      <AdapterCard
        {...defaultProps({ instance: claudeInstance, manifest: claudeManifest })}
      />,
    );

    await openKebabMenu();

    await waitFor(() => {
      const removeItem = screen.getByRole('menuitem', { name: /Remove/i });
      expect(removeItem).toBeTruthy();
      expect(removeItem.getAttribute('data-disabled')).not.toBeNull();
    });
  });
});
