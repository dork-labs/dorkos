/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AdapterCardHeader } from '../AdapterCardHeader';
import type { AdapterManifest, CatalogInstance } from '@dorkos/shared/relay-schemas';

// Mock adapter logos — renders a simple span with the component name for testability
vi.mock('@dorkos/icons/adapter-logos', () => ({
  ADAPTER_LOGO_MAP: {
    telegram: ({ size, className }: { size?: number; className?: string }) => (
      <span data-testid="adapter-logo" data-icon="telegram" className={className}>
        TelegramLogo
      </span>
    ),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseManifest: AdapterManifest = {
  type: 'telegram',
  displayName: 'Telegram',
  description: 'Telegram messaging adapter',
  iconId: 'telegram',
  category: 'messaging',
  builtin: false,
  configFields: [],
  multiInstance: false,
};

const deprecatedManifest: AdapterManifest = {
  ...baseManifest,
  deprecated: true,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultProps(overrides: Partial<Parameters<typeof AdapterCardHeader>[0]> = {}) {
  return {
    manifest: baseManifest,
    instance: connectedInstance,
    primaryName: 'Main Telegram',
    secondaryName: null as string | null,
    statusDotClass: 'size-2 shrink-0 rounded-full bg-green-500',
    onToggle: vi.fn(),
    onShowEvents: vi.fn(),
    onConfigure: vi.fn(),
    onRemove: vi.fn(),
    onAddBinding: vi.fn(),
    isBuiltinClaude: false,
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

describe('AdapterCardHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // -------------------------------------------------------------------------
  // Basic rendering
  // -------------------------------------------------------------------------

  it('renders primary name', () => {
    render(<AdapterCardHeader {...defaultProps()} />);
    expect(screen.getByText('Main Telegram')).toBeInTheDocument();
  });

  it('renders adapter icon when iconId is provided', () => {
    render(<AdapterCardHeader {...defaultProps()} />);
    expect(screen.getByTestId('adapter-logo')).toBeInTheDocument();
  });

  it('renders the category badge', () => {
    render(<AdapterCardHeader {...defaultProps()} />);
    expect(screen.getByText('messaging')).toBeInTheDocument();
  });

  it('renders secondary name when provided', () => {
    render(<AdapterCardHeader {...defaultProps({ secondaryName: 'Telegram' })} />);
    expect(screen.getByText('Telegram')).toBeInTheDocument();
  });

  it('does not render secondary name when null', () => {
    render(<AdapterCardHeader {...defaultProps({ secondaryName: null })} />);
    // Only the primary name should appear
    expect(screen.queryByText('Telegram')).not.toBeInTheDocument();
  });

  it('renders status dot with provided class', () => {
    const { container } = render(
      <AdapterCardHeader
        {...defaultProps({ statusDotClass: 'size-2 shrink-0 rounded-full bg-amber-500' })}
      />
    );
    expect(container.querySelector('.bg-amber-500')).toBeTruthy();
  });

  it('renders deprecated badge when manifest is deprecated', () => {
    render(<AdapterCardHeader {...defaultProps({ manifest: deprecatedManifest })} />);
    expect(screen.getByText('Deprecated')).toBeInTheDocument();
  });

  it('does not render deprecated badge when manifest is not deprecated', () => {
    render(<AdapterCardHeader {...defaultProps()} />);
    expect(screen.queryByText('Deprecated')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Switch / toggle
  // -------------------------------------------------------------------------

  it('renders switch in checked state when adapter is enabled', () => {
    render(<AdapterCardHeader {...defaultProps()} />);
    const switchEl = screen.getByRole('switch');
    expect(switchEl.getAttribute('data-state')).toBe('checked');
  });

  it('renders switch in unchecked state when adapter is disabled', () => {
    render(<AdapterCardHeader {...defaultProps({ instance: disabledInstance })} />);
    const switchEl = screen.getByRole('switch');
    expect(switchEl.getAttribute('data-state')).toBe('unchecked');
  });

  it('calls onToggle with true when switch is clicked while disabled', () => {
    const onToggle = vi.fn();
    render(<AdapterCardHeader {...defaultProps({ instance: disabledInstance, onToggle })} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('calls onToggle with false when switch is clicked while enabled', () => {
    const onToggle = vi.fn();
    render(<AdapterCardHeader {...defaultProps({ onToggle })} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  // -------------------------------------------------------------------------
  // Kebab menu
  // -------------------------------------------------------------------------

  it('opens kebab menu when clicking the actions button', async () => {
    render(<AdapterCardHeader {...defaultProps()} />);

    await openKebabMenu();

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /Configure/i })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /Remove/i })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /Events/i })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /Add Binding/i })).toBeInTheDocument();
    });
  });

  it('calls onConfigure when Configure menu item is clicked', async () => {
    const onConfigure = vi.fn();
    render(<AdapterCardHeader {...defaultProps({ onConfigure })} />);

    await openKebabMenu();
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /Configure/i })).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Configure/i }));
    });

    expect(onConfigure).toHaveBeenCalledTimes(1);
  });

  it('calls onRemove when Remove menu item is clicked', async () => {
    const onRemove = vi.fn();
    render(<AdapterCardHeader {...defaultProps({ onRemove })} />);

    await openKebabMenu();
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /Remove/i })).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Remove/i }));
    });

    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('calls onShowEvents when Events menu item is clicked', async () => {
    const onShowEvents = vi.fn();
    render(<AdapterCardHeader {...defaultProps({ onShowEvents })} />);

    await openKebabMenu();
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /Events/i })).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Events/i }));
    });

    expect(onShowEvents).toHaveBeenCalledTimes(1);
  });

  it('calls onAddBinding when Add Binding menu item is clicked', async () => {
    const onAddBinding = vi.fn();
    render(<AdapterCardHeader {...defaultProps({ onAddBinding })} />);

    await openKebabMenu();
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /Add Binding/i })).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Add Binding/i }));
    });

    expect(onAddBinding).toHaveBeenCalledTimes(1);
  });

  it('disables Remove menu item for built-in Claude adapter', async () => {
    render(<AdapterCardHeader {...defaultProps({ isBuiltinClaude: true })} />);

    await openKebabMenu();

    await waitFor(() => {
      const removeItem = screen.getByRole('menuitem', { name: /Remove/i });
      expect(removeItem).toBeInTheDocument();
      expect(removeItem.getAttribute('data-disabled')).not.toBeNull();
    });
  });
});
