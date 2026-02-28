/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { BindingDialog } from '../BindingDialog';

// Mock matchMedia for Radix/responsive-dialog internals that check viewport size
beforeEach(() => {
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

afterEach(cleanup);

/** Get the rendered dialog element (Radix renders content in a portal). */
function getDialog() {
  return screen.getByRole('dialog');
}

describe('BindingDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    adapterName: 'Telegram Bot',
    agentName: 'Support Agent',
    onConfirm: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders the dialog title when open', () => {
      render(<BindingDialog {...defaultProps} />);
      // Title is an h2; button with same text also exists, so query by role
      expect(screen.getByRole('heading', { name: 'Create Binding' })).toBeInTheDocument();
    });

    it('renders adapter and agent names in description', () => {
      render(<BindingDialog {...defaultProps} />);
      const dialog = getDialog();
      expect(within(dialog).getByText('Telegram Bot')).toBeInTheDocument();
      expect(within(dialog).getByText('Support Agent')).toBeInTheDocument();
    });

    it('renders session strategy label', () => {
      render(<BindingDialog {...defaultProps} />);
      expect(screen.getByText('Session Strategy')).toBeInTheDocument();
    });

    it('renders label input with placeholder', () => {
      render(<BindingDialog {...defaultProps} />);
      const dialog = getDialog();
      expect(
        within(dialog).getByPlaceholderText('e.g., Customer support bot'),
      ).toBeInTheDocument();
    });

    it('renders Create Binding and Cancel buttons', () => {
      render(<BindingDialog {...defaultProps} />);
      const dialog = getDialog();
      expect(within(dialog).getByRole('button', { name: /create binding/i })).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('shows the per-chat strategy description by default', () => {
      render(<BindingDialog {...defaultProps} />);
      expect(
        screen.getByText(/one session per chat\/conversation/i),
      ).toBeInTheDocument();
    });
  });

  describe('confirm action', () => {
    it('calls onConfirm with default per-chat strategy and empty label', () => {
      const onConfirm = vi.fn();
      render(<BindingDialog {...defaultProps} onConfirm={onConfirm} />);
      fireEvent.click(screen.getByRole('button', { name: /create binding/i }));
      expect(onConfirm).toHaveBeenCalledWith({ sessionStrategy: 'per-chat', label: '' });
    });

    it('calls onConfirm with typed label', () => {
      const onConfirm = vi.fn();
      render(<BindingDialog {...defaultProps} onConfirm={onConfirm} />);
      const labelInput = screen.getByPlaceholderText('e.g., Customer support bot');
      fireEvent.change(labelInput, { target: { value: 'Customer support' } });
      fireEvent.click(screen.getByRole('button', { name: /create binding/i }));
      expect(onConfirm).toHaveBeenCalledWith({
        sessionStrategy: 'per-chat',
        label: 'Customer support',
      });
    });
  });

  describe('cancel action', () => {
    it('calls onOpenChange(false) when Cancel is clicked', () => {
      const onOpenChange = vi.fn();
      render(<BindingDialog {...defaultProps} onOpenChange={onOpenChange} />);
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe('adapter and agent name display', () => {
    it('renders different adapter and agent names correctly', () => {
      render(
        <BindingDialog
          {...defaultProps}
          adapterName="Webhook Receiver"
          agentName="Code Reviewer"
        />,
      );
      const dialog = getDialog();
      expect(within(dialog).getByText('Webhook Receiver')).toBeInTheDocument();
      expect(within(dialog).getByText('Code Reviewer')).toBeInTheDocument();
    });
  });
});
