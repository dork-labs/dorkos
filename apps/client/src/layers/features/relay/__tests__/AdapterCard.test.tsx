/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { AdapterCard } from '../ui/AdapterCard';
import type { AdapterManifest, CatalogInstance } from '@dorkos/shared/relay-schemas';

// ---------------------------------------------------------------------------
// Mock entity hooks — AdapterCard calls useBindings and useRegisteredAgents
// ---------------------------------------------------------------------------

const mockUseBindings = vi.fn();
const mockUseRegisteredAgents = vi.fn();
const mockMutate = vi.fn();
const mockMutateAsync = vi.fn().mockResolvedValue(undefined);

vi.mock('@/layers/entities/binding', () => ({
  useBindings: (...args: unknown[]) => mockUseBindings(...args),
  useCreateBinding: () => ({ mutate: mockMutate, mutateAsync: mockMutateAsync, isPending: false }),
  useUpdateBinding: () => ({ mutate: mockMutate, mutateAsync: mockMutateAsync, isPending: false }),
  useDeleteBinding: () => ({ mutate: mockMutate, mutateAsync: mockMutateAsync, isPending: false }),
}));

vi.mock('@/layers/entities/mesh', () => ({
  useRegisteredAgents: (...args: unknown[]) => mockUseRegisteredAgents(...args),
}));

// Mock adapter logos — renders a simple span for testability
vi.mock('@dorkos/icons/adapter-logos', () => ({
  ADAPTER_LOGO_MAP: {
    telegram: ({ size, className }: { size?: number; className?: string }) => (
      <span data-testid="adapter-logo" data-icon="telegram" className={className}>
        TelegramLogo
      </span>
    ),
    'claude-code': ({ size, className }: { size?: number; className?: string }) => (
      <span data-testid="adapter-logo" data-icon="claude-code" className={className}>
        AnthropicLogo
      </span>
    ),
  },
}));

// BindingDialog is no longer rendered inside AdapterCard — dialogs live in ConnectionsTab.

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

const claudeManifest: AdapterManifest = {
  type: 'claude-code',
  displayName: 'Claude Code',
  description: 'Built-in Claude Code adapter',
  iconId: 'claude-code',
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
    onShowEvents: vi.fn(),
    onEditBinding: vi.fn(),
    onRemoveConfirm: vi.fn(),
    onAddBinding: vi.fn(),
    ...overrides,
  };
}

function makeBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    adapterId: 'tg-main',
    agentId: 'agent-1',
    sessionStrategy: 'per-chat',
    label: '',
    createdAt: '',
    updatedAt: '',
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
    mockUseBindings.mockReturnValue({ data: [] });
    mockUseRegisteredAgents.mockReturnValue({ data: { agents: [] } });
  });

  afterEach(() => {
    cleanup();
  });

  // -------------------------------------------------------------------------
  // Basic rendering
  // -------------------------------------------------------------------------

  it('renders the adapter display name', () => {
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.getByText('Main Telegram')).toBeTruthy();
  });

  it('renders the category badge', () => {
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.getByText('messaging')).toBeTruthy();
  });

  it('renders the adapter icon', () => {
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.getByTestId('adapter-logo')).toBeTruthy();
  });

  it('does not render raw message counts', () => {
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.queryByText(/In: 42/)).toBeNull();
    expect(screen.queryByText(/Out: 18/)).toBeNull();
  });

  it('does not render left border color classes', () => {
    const { container } = render(<AdapterCard {...defaultProps()} />);
    expect(container.querySelector('.border-l-green-500')).toBeNull();
    expect(container.querySelector('.border-l-2')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Card styling
  // -------------------------------------------------------------------------

  it('renders with rounded-xl and shadow-soft classes', () => {
    const { container } = render(<AdapterCard {...defaultProps()} />);
    const card = container.firstElementChild;
    expect(card?.className).toContain('rounded-xl');
    expect(card?.className).toContain('shadow-soft');
  });

  it('renders external adapter with solid border (not dashed)', () => {
    const { container } = render(<AdapterCard {...defaultProps()} />);
    const card = container.firstElementChild;
    expect(card?.className).not.toContain('border-dashed');
  });

  it('renders CCA card with dashed border', () => {
    const { container } = render(
      <AdapterCard {...defaultProps({ instance: claudeInstance, manifest: claudeManifest })} />
    );
    const card = container.firstElementChild;
    expect(card?.className).toContain('border-dashed');
  });

  // -------------------------------------------------------------------------
  // Status dot
  // -------------------------------------------------------------------------

  it('shows green status dot when connected with bindings', () => {
    mockUseBindings.mockReturnValue({ data: [makeBinding()] });
    const { container } = render(<AdapterCard {...defaultProps()} />);
    expect(container.querySelector('.bg-green-500')).toBeTruthy();
  });

  it('shows amber pulsing status dot when connected with no bindings', () => {
    const { container } = render(<AdapterCard {...defaultProps()} />);
    expect(container.querySelector('.bg-amber-500')).toBeTruthy();
    expect(container.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('shows red status dot when adapter is in error state', () => {
    const { container } = render(<AdapterCard {...defaultProps({ instance: errorInstance })} />);
    expect(container.querySelector('.bg-red-500')).toBeTruthy();
  });

  it('shows gray status dot when adapter is disconnected', () => {
    const { container } = render(<AdapterCard {...defaultProps({ instance: disabledInstance })} />);
    expect(container.querySelector('.bg-gray-400')).toBeTruthy();
  });

  it('shows green status dot for CCA when connected (always considered bound)', () => {
    mockUseBindings.mockReturnValue({ data: [] });
    const { container } = render(
      <AdapterCard {...defaultProps({ instance: claudeInstance, manifest: claudeManifest })} />
    );
    expect(container.querySelector('.bg-green-500')).toBeTruthy();
    expect(container.querySelector('.bg-amber-500')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // CCA card treatment
  // -------------------------------------------------------------------------

  it('shows "Serving N agents" for CCA instead of "No agent bound"', () => {
    mockUseRegisteredAgents.mockReturnValue({
      data: {
        agents: [
          { id: 'a1', name: 'Bot 1' },
          { id: 'a2', name: 'Bot 2' },
          { id: 'a3', name: 'Bot 3' },
        ],
      },
    });
    render(
      <AdapterCard {...defaultProps({ instance: claudeInstance, manifest: claudeManifest })} />
    );
    expect(screen.getByText(/Serving 3 agents/)).toBeTruthy();
    expect(screen.queryByText('No agent bound')).toBeNull();
  });

  it('shows singular "agent" when CCA serves exactly 1', () => {
    mockUseRegisteredAgents.mockReturnValue({
      data: { agents: [{ id: 'a1', name: 'Solo Bot' }] },
    });
    render(
      <AdapterCard {...defaultProps({ instance: claudeInstance, manifest: claudeManifest })} />
    );
    expect(screen.getByText(/Serving 1 agent/)).toBeTruthy();
  });

  it('does not show System badge for CCA', () => {
    render(
      <AdapterCard {...defaultProps({ instance: claudeInstance, manifest: claudeManifest })} />
    );
    expect(screen.queryByText('System')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Binding rows
  // -------------------------------------------------------------------------

  it('shows individual binding rows with agent names', () => {
    mockUseBindings.mockReturnValue({
      data: [
        makeBinding({ id: 'b1', agentId: 'agent-1' }),
        makeBinding({ id: 'b2', agentId: 'agent-2' }),
      ],
    });
    mockUseRegisteredAgents.mockReturnValue({
      data: {
        agents: [
          { id: 'agent-1', name: 'Alpha Bot' },
          { id: 'agent-2', name: 'Beta Bot' },
        ],
      },
    });
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.getByText('Alpha Bot')).toBeTruthy();
    expect(screen.getByText('Beta Bot')).toBeTruthy();
  });

  it('shows strategy badge on binding rows', () => {
    mockUseBindings.mockReturnValue({
      data: [makeBinding({ sessionStrategy: 'per-user' })],
    });
    mockUseRegisteredAgents.mockReturnValue({
      data: { agents: [{ id: 'agent-1', name: 'Alpha Bot' }] },
    });
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.getByText('Per User')).toBeTruthy();
  });

  it('shows chatId badge when binding has chatId', () => {
    mockUseBindings.mockReturnValue({
      data: [makeBinding({ chatId: 'support-chat', channelType: 'group' })],
    });
    mockUseRegisteredAgents.mockReturnValue({
      data: { agents: [{ id: 'agent-1', name: 'Alpha Bot' }] },
    });
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.getByText('#support-chat')).toBeTruthy();
  });

  it('falls back to agentId when agent is not in registry', () => {
    mockUseBindings.mockReturnValue({
      data: [makeBinding({ agentId: 'agent-unknown' })],
    });
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.getByText('agent-unknown')).toBeTruthy();
  });

  it('shows "and N more" when bindings exceed 3', () => {
    mockUseBindings.mockReturnValue({
      data: [
        makeBinding({ id: 'b1', agentId: 'a1' }),
        makeBinding({ id: 'b2', agentId: 'a2' }),
        makeBinding({ id: 'b3', agentId: 'a3' }),
        makeBinding({ id: 'b4', agentId: 'a4' }),
        makeBinding({ id: 'b5', agentId: 'a5' }),
      ],
    });
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.getByText('Show 2 more')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // No-bindings state
  // -------------------------------------------------------------------------

  it('shows "Add binding" CTA button when connected with no bindings', () => {
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.getByRole('button', { name: /add binding/i })).toBeTruthy();
  });

  it('does not show "Add binding" CTA when disconnected', () => {
    render(<AdapterCard {...defaultProps({ instance: disabledInstance })} />);
    // No bindings and disconnected — CTA should not appear
    expect(screen.queryByRole('button', { name: /^add binding$/i })).toBeNull();
  });

  it('does not show "No agent bound" amber text (replaced by CTA button)', () => {
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.queryByText('No agent bound')).toBeNull();
  });

  it('does not show "No agent bound" when bindings exist', () => {
    mockUseBindings.mockReturnValue({ data: [makeBinding()] });
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.queryByText('No agent bound')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Error display
  // -------------------------------------------------------------------------

  it('shows error count badge when errorCount > 0', () => {
    render(<AdapterCard {...defaultProps({ instance: errorInstance })} />);
    expect(screen.getByText(/3 errors/)).toBeTruthy();
  });

  it('does not show error indicator when errorCount is 0', () => {
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.queryByText(/error/i)).toBeNull();
  });

  it('shows lastError message in collapsible when expanded', async () => {
    render(<AdapterCard {...defaultProps({ instance: errorInstance })} />);
    const trigger = screen.getByRole('button', { name: 'Toggle full error message' });

    await act(async () => {
      fireEvent.click(trigger);
    });

    await waitFor(() => {
      expect(screen.getByText('Connection timed out')).toBeTruthy();
    });
  });

  it('renders Collapsible trigger when lastError is set', () => {
    render(<AdapterCard {...defaultProps({ instance: errorInstance })} />);
    const trigger = screen.getByRole('button', { name: 'Toggle full error message' });
    expect(trigger).toBeTruthy();
  });

  it('does not render Collapsible when lastError is null', () => {
    render(<AdapterCard {...defaultProps()} />);
    expect(screen.queryByRole('button', { name: 'Toggle full error message' })).toBeNull();
  });

  it('shows full error text when trigger is clicked', async () => {
    render(<AdapterCard {...defaultProps({ instance: errorInstance })} />);
    const trigger = screen.getByRole('button', { name: 'Toggle full error message' });

    await act(async () => {
      fireEvent.click(trigger);
    });

    await waitFor(() => {
      const collapsibleContent = document.querySelector('[data-slot="collapsible-content"]');
      expect(collapsibleContent?.getAttribute('data-state')).toBe('open');
    });
  });

  // -------------------------------------------------------------------------
  // Switch / toggle
  // -------------------------------------------------------------------------

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
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('calls onToggle with false when switch is clicked while enabled', () => {
    const onToggle = vi.fn();
    render(<AdapterCard {...defaultProps({ onToggle })} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  // -------------------------------------------------------------------------
  // Label display
  // -------------------------------------------------------------------------

  it('shows label as primary text when label is set', () => {
    const labeledInstance: CatalogInstance = {
      ...connectedInstance,
      label: 'My Bot',
    };
    render(<AdapterCard {...defaultProps({ instance: labeledInstance })} />);
    expect(screen.getByText('My Bot')).toBeTruthy();
  });

  it('shows adapter type displayName as secondary text when label is set', () => {
    const labeledInstance: CatalogInstance = {
      ...connectedInstance,
      label: 'My Bot',
    };
    render(<AdapterCard {...defaultProps({ instance: labeledInstance })} />);
    expect(screen.getByText('My Bot')).toBeTruthy();
    expect(screen.getByText('Main Telegram')).toBeTruthy();
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
  // Kebab menu
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

  it('calls onRemoveConfirm when Remove menu item is clicked', async () => {
    const onRemoveConfirm = vi.fn();
    render(<AdapterCard {...defaultProps({ onRemoveConfirm })} />);

    await openKebabMenu();

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /Remove/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Remove/i }));
    });

    expect(onRemoveConfirm).toHaveBeenCalledWith('tg-main', 'Main Telegram');
  });

  it('calls onShowEvents when Events menu item is clicked', async () => {
    const onShowEvents = vi.fn();
    render(<AdapterCard {...defaultProps({ onShowEvents })} />);

    await openKebabMenu();

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /Events/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Events/i }));
    });

    expect(onShowEvents).toHaveBeenCalledWith('tg-main');
  });

  it('calls onAddBinding when Add Binding menu item is clicked', async () => {
    const onAddBinding = vi.fn();
    render(<AdapterCard {...defaultProps({ onAddBinding })} />);

    await openKebabMenu();

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /Add Binding/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Add Binding/i }));
    });

    expect(onAddBinding).toHaveBeenCalledWith('tg-main', 'tg-main');
  });

  it('disables Remove for built-in claude-code adapter', async () => {
    render(
      <AdapterCard {...defaultProps({ instance: claudeInstance, manifest: claudeManifest })} />
    );

    await openKebabMenu();

    await waitFor(() => {
      const removeItem = screen.getByRole('menuitem', { name: /Remove/i });
      expect(removeItem).toBeTruthy();
      expect(removeItem.getAttribute('data-disabled')).not.toBeNull();
    });
  });
});
