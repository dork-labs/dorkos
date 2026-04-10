/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { BindingDialog, type BindingFormValues } from '../ui/BindingDialog';

// ---------------------------------------------------------------------------
// Mock entity hooks
// ---------------------------------------------------------------------------

const mockUseAdapterCatalog = vi.fn();
const mockUseObservedChats = vi.fn();
const mockUseRegisteredAgents = vi.fn();

vi.mock('@/layers/entities/relay', () => ({
  useAdapterCatalog: (...args: unknown[]) => mockUseAdapterCatalog(...args),
  useObservedChats: (...args: unknown[]) => mockUseObservedChats(...args),
}));

vi.mock('@/layers/entities/mesh', () => ({
  useRegisteredAgents: (...args: unknown[]) => mockUseRegisteredAgents(...args),
}));

// Stub BindingAdvancedSection to keep tests focused on the dialog shell.
vi.mock('../ui/BindingAdvancedSection', () => ({
  BindingAdvancedSection: () => <div data-testid="advanced-section" />,
}));

// Mock matchMedia for ResponsiveDialog (uses useIsMobile internally).
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
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const adapters = [
  {
    manifest: { displayName: 'Telegram', type: 'telegram' },
    instances: [{ id: 'tg-1', enabled: true, label: '' }],
  },
];

const agents = [
  { id: 'agent-1', name: 'Alpha Bot' },
  { id: 'agent-2', name: 'Beta Bot' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultProps(overrides: Partial<Parameters<typeof BindingDialog>[0]> = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BindingDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAdapterCatalog.mockReturnValue({ data: adapters });
    mockUseObservedChats.mockReturnValue({ data: [] });
    mockUseRegisteredAgents.mockReturnValue({ data: { agents } });
  });

  afterEach(() => {
    cleanup();
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  it('disables submit button when no adapter or agent is selected', () => {
    render(<BindingDialog {...defaultProps()} />);
    const submitBtn = screen.getByRole('button', { name: /create binding/i });
    expect(submitBtn).toBeDisabled();
  });

  it('enables submit button when both adapter and agent are selected', () => {
    render(
      <BindingDialog
        {...defaultProps({ initialValues: { adapterId: 'tg-1', agentId: 'agent-1' } })}
      />
    );
    const submitBtn = screen.getByRole('button', { name: /create binding/i });
    expect(submitBtn).not.toBeDisabled();
  });

  it('does not call onConfirm when form is invalid', () => {
    const onConfirm = vi.fn();
    render(<BindingDialog {...defaultProps({ onConfirm })} />);
    const submitBtn = screen.getByRole('button', { name: /create binding/i });
    fireEvent.click(submitBtn);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('calls onConfirm with form values on valid submit', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <BindingDialog
        {...defaultProps({
          onConfirm,
          initialValues: { adapterId: 'tg-1', agentId: 'agent-1' },
        })}
      />
    );
    const submitBtn = screen.getByRole('button', { name: /create binding/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    const values: BindingFormValues = onConfirm.mock.calls[0][0];
    expect(values.adapterId).toBe('tg-1');
    expect(values.agentId).toBe('agent-1');
  });

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------

  it('shows loading state when isPending is true', () => {
    render(
      <BindingDialog
        {...defaultProps({
          isPending: true,
          initialValues: { adapterId: 'tg-1', agentId: 'agent-1' },
        })}
      />
    );
    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
  });

  it('shows "Save Changes" text in edit mode', () => {
    render(
      <BindingDialog
        {...defaultProps({
          mode: 'edit',
          adapterName: 'Telegram',
          agentName: 'Alpha Bot',
          initialValues: { adapterId: 'tg-1', agentId: 'agent-1' },
        })}
      />
    );
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Empty states
  // -------------------------------------------------------------------------

  it('shows empty state when no adapters are available', () => {
    mockUseAdapterCatalog.mockReturnValue({ data: [] });
    render(<BindingDialog {...defaultProps()} />);
    expect(screen.getByText('No adapters configured')).toBeInTheDocument();
  });

  it('shows empty state when no agents are registered', () => {
    mockUseRegisteredAgents.mockReturnValue({ data: { agents: [] } });
    render(<BindingDialog {...defaultProps()} />);
    expect(screen.getByText('No agents registered')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Field descriptions
  // -------------------------------------------------------------------------

  it('shows field description under label input', () => {
    render(<BindingDialog {...defaultProps()} />);
    expect(screen.getByText('A display name for this binding')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Edit mode
  // -------------------------------------------------------------------------

  it('shows read-only adapter and agent names in edit mode', () => {
    render(
      <BindingDialog
        {...defaultProps({
          mode: 'edit',
          adapterName: 'Telegram',
          agentName: 'Alpha Bot',
          initialValues: { adapterId: 'tg-1', agentId: 'agent-1' },
        })}
      />
    );
    expect(screen.getByText('Telegram')).toBeInTheDocument();
    expect(screen.getByText('Alpha Bot')).toBeInTheDocument();
  });

  it('disables submit in edit mode when no fields have changed', () => {
    render(
      <BindingDialog
        {...defaultProps({
          mode: 'edit',
          adapterName: 'Telegram',
          agentName: 'Alpha Bot',
          initialValues: { adapterId: 'tg-1', agentId: 'agent-1' },
        })}
      />
    );
    const submitBtn = screen.getByRole('button', { name: /save changes/i });
    expect(submitBtn).toBeDisabled();
  });

  it('enables submit in edit mode when a field is modified', () => {
    render(
      <BindingDialog
        {...defaultProps({
          mode: 'edit',
          adapterName: 'Telegram',
          agentName: 'Alpha Bot',
          initialValues: { adapterId: 'tg-1', agentId: 'agent-1' },
        })}
      />
    );
    const labelInput = screen.getByPlaceholderText('e.g., Customer support bot');
    fireEvent.change(labelInput, { target: { value: 'New label' } });
    const submitBtn = screen.getByRole('button', { name: /save changes/i });
    expect(submitBtn).not.toBeDisabled();
  });

  it('disables submit in edit mode when field is reverted to initial value', () => {
    render(
      <BindingDialog
        {...defaultProps({
          mode: 'edit',
          adapterName: 'Telegram',
          agentName: 'Alpha Bot',
          initialValues: { adapterId: 'tg-1', agentId: 'agent-1', label: 'Original' },
        })}
      />
    );
    const labelInput = screen.getByPlaceholderText('e.g., Customer support bot');
    fireEvent.change(labelInput, { target: { value: 'Changed' } });
    expect(screen.getByRole('button', { name: /save changes/i })).not.toBeDisabled();
    fireEvent.change(labelInput, { target: { value: 'Original' } });
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // Preview sentence
  // -------------------------------------------------------------------------

  it('shows preview sentence when form is valid', () => {
    render(
      <BindingDialog
        {...defaultProps({
          initialValues: { adapterId: 'tg-1', agentId: 'agent-1' },
        })}
      />
    );
    expect(
      screen.getByText(/One thread for each conversation — routed to Alpha Bot\./)
    ).toBeInTheDocument();
  });

  it('does not show preview sentence when form is incomplete', () => {
    render(<BindingDialog {...defaultProps()} />);
    expect(screen.queryByText(/routed to/)).not.toBeInTheDocument();
  });
});
