// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@/layers/shared/ui';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import { ChannelBindingCard } from '../ChannelBindingCard';

// --- Test fixtures ---

function makeBinding(overrides: Partial<AdapterBinding> = {}): AdapterBinding {
  return {
    id: 'b-001',
    adapterId: 'telegram-1',
    agentId: 'agent-001',
    sessionStrategy: 'per-chat',
    label: '',
    permissionMode: 'acceptEdits',
    canInitiate: false,
    canReply: true,
    canReceive: true,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderCard(props: Partial<React.ComponentProps<typeof ChannelBindingCard>> = {}) {
  const defaultProps: React.ComponentProps<typeof ChannelBindingCard> = {
    binding: makeBinding(),
    channelName: 'Telegram',
    adapterState: 'connected',
    onEdit: vi.fn(),
    onRemove: vi.fn(),
    ...props,
  };
  const { container } = render(
    <TooltipProvider>
      <ChannelBindingCard {...defaultProps} />
    </TooltipProvider>
  );
  return { view: within(container), container, props: defaultProps };
}

// --- Tests ---

describe('ChannelBindingCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders channel name', () => {
    const { view } = renderCard();
    expect(view.getByText('Telegram')).toBeInTheDocument();
  });

  it('renders session strategy badge', () => {
    const { view } = renderCard();
    expect(view.getByText('per-chat')).toBeInTheDocument();
  });

  it('renders chatId badge when present', () => {
    const { view } = renderCard({
      binding: makeBinding({ chatId: '-100123456' }),
    });
    expect(view.getByText('-100123456')).toBeInTheDocument();
  });

  it('does not render chatId badge when absent', () => {
    const { view } = renderCard();
    // Only the strategy badge should be present
    const badges = view.getAllByText('per-chat');
    expect(badges).toHaveLength(1);
  });

  describe('status dot', () => {
    it('shows green dot when connected', () => {
      const { container } = renderCard({ adapterState: 'connected' });
      const dot = container.querySelector('.bg-green-500');
      expect(dot).toBeInTheDocument();
    });

    it('shows amber dot when disconnected', () => {
      const { container } = renderCard({ adapterState: 'disconnected' });
      const dot = container.querySelector('.bg-amber-500');
      expect(dot).toBeInTheDocument();
    });

    it('shows red dot when error', () => {
      const { container } = renderCard({ adapterState: 'error' });
      const dot = container.querySelector('.bg-red-500');
      expect(dot).toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('shows error message when adapter is in error state', () => {
      const { view } = renderCard({
        adapterState: 'error',
        errorMessage: 'Connection refused',
      });
      expect(view.getByText('Connection refused')).toBeInTheDocument();
    });

    it('does not show error message when adapter is connected', () => {
      const { view } = renderCard({
        adapterState: 'connected',
        errorMessage: 'some error',
      });
      expect(view.queryByText('some error')).not.toBeInTheDocument();
    });

    it('applies error border class when in error state', () => {
      const { container } = renderCard({ adapterState: 'error' });
      const card = container.querySelector('.border-red-500\\/50');
      expect(card).toBeInTheDocument();
    });
  });

  describe('permission icons', () => {
    // Tooltip content renders in a portal only when open, so we test for the
    // presence/absence of the icon SVG element by its lucide class name instead.
    it('shows initiate icon when canInitiate is true', () => {
      const { container } = renderCard({
        binding: makeBinding({ canInitiate: true }),
      });
      expect(container.querySelector('.lucide-zap')).toBeInTheDocument();
    });

    it('does not show initiate icon when canInitiate is false', () => {
      const { container } = renderCard({
        binding: makeBinding({ canInitiate: false }),
      });
      expect(container.querySelector('.lucide-zap')).not.toBeInTheDocument();
    });

    it('shows "cannot reply" icon when canReply is false', () => {
      const { container } = renderCard({
        binding: makeBinding({ canReply: false }),
      });
      expect(container.querySelector('.lucide-message-square-off')).toBeInTheDocument();
    });

    it('does not show "cannot reply" icon when canReply is true', () => {
      const { container } = renderCard({
        binding: makeBinding({ canReply: true }),
      });
      expect(container.querySelector('.lucide-message-square-off')).not.toBeInTheDocument();
    });

    it('shows "cannot receive" icon when canReceive is false', () => {
      const { container } = renderCard({
        binding: makeBinding({ canReceive: false }),
      });
      expect(container.querySelector('.lucide-bell-off')).toBeInTheDocument();
    });

    it('does not show "cannot receive" icon when canReceive is true', () => {
      const { container } = renderCard({
        binding: makeBinding({ canReceive: true }),
      });
      expect(container.querySelector('.lucide-bell-off')).not.toBeInTheDocument();
    });
  });

  describe('hover actions', () => {
    it('calls onEdit when Edit button is clicked', () => {
      const onEdit = vi.fn();
      const { view } = renderCard({ onEdit });
      fireEvent.click(view.getByText('Edit'));
      expect(onEdit).toHaveBeenCalledTimes(1);
    });

    it('shows remove confirmation dialog when Remove is clicked', () => {
      const { view } = renderCard({ channelName: 'Telegram' });
      fireEvent.click(view.getByText('Remove'));
      // AlertDialog renders via portal — use screen to find portal content
      expect(screen.getByText('Remove channel binding')).toBeInTheDocument();
      expect(
        screen.getByText(
          /Remove the binding to Telegram\? The agent will no longer receive messages from this channel\./
        )
      ).toBeInTheDocument();
    });

    it('calls onRemove when removal is confirmed', () => {
      const onRemove = vi.fn();
      const { view } = renderCard({ onRemove });

      fireEvent.click(view.getByText('Remove'));

      // AlertDialog renders via portal — find the red confirm button there
      const dialogContent = screen.getByRole('alertdialog');
      const confirmButton = within(dialogContent)
        .getAllByRole('button')
        .find((el) => el.textContent === 'Remove');
      expect(confirmButton).toBeDefined();
      fireEvent.click(confirmButton!);
      expect(onRemove).toHaveBeenCalledTimes(1);
    });

    it('does not call onRemove when Cancel is clicked in confirmation', () => {
      const onRemove = vi.fn();
      const { view } = renderCard({ onRemove });

      fireEvent.click(view.getByText('Remove'));
      // AlertDialog renders via portal
      const dialogContent = screen.getByRole('alertdialog');
      fireEvent.click(within(dialogContent).getByText('Cancel'));
      expect(onRemove).not.toHaveBeenCalled();
    });
  });
});
