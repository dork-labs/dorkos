// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@/layers/shared/ui';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import { ChannelBindingCard } from '../ChannelBindingCard';
import type { CardAdapterState } from '../ChannelBindingCard';

// Mock AdapterIcon to avoid logo resolution in tests
vi.mock('@/layers/features/relay', () => ({
  AdapterIcon: ({ adapterType }: { adapterType?: string }) => (
    <span data-testid="adapter-icon" data-adapter-type={adapterType} />
  ),
  ADAPTER_STATE_DOT_CLASS: {
    connected: 'bg-green-500',
    disconnected: 'bg-muted-foreground',
    error: 'bg-red-500',
    starting: 'bg-amber-500 motion-safe:animate-pulse',
    stopping: 'bg-amber-500 motion-safe:animate-pulse',
    reconnecting: 'bg-amber-500 motion-safe:animate-pulse',
  },
}));

// Mock buildPreviewSentence to return deterministic text in tests
vi.mock('@/layers/features/mesh/lib/build-preview-sentence', () => ({
  buildPreviewSentence: vi.fn(() => 'One thread for each conversation'),
}));

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
    channelAdapterType: 'telegram',
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

  it('renders channel name as primary text', () => {
    const { view } = renderCard();
    expect(view.getByText('Telegram')).toBeInTheDocument();
  });

  it('renders channel name + chat display name with em-dash when chatDisplayName provided', () => {
    const { view } = renderCard({ chatDisplayName: 'Dev chat' });
    expect(view.getByText('Telegram — Dev chat')).toBeInTheDocument();
  });

  it('renders AdapterIcon with channelAdapterType', () => {
    const { view } = renderCard({ channelAdapterType: 'telegram' });
    const icon = view.getByTestId('adapter-icon');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute('data-adapter-type', 'telegram');
  });

  it('renders preview sentence from buildPreviewSentence', () => {
    const { view } = renderCard();
    expect(view.getByText('One thread for each conversation')).toBeInTheDocument();
  });

  it('never renders raw sessionStrategy text', () => {
    const { view } = renderCard({ binding: makeBinding({ sessionStrategy: 'per-chat' }) });
    expect(view.queryByText('per-chat')).not.toBeInTheDocument();
  });

  it('never renders raw chatId text', () => {
    const { view } = renderCard({ binding: makeBinding({ chatId: '-100123456' }) });
    expect(view.queryByText('-100123456')).not.toBeInTheDocument();
  });

  describe('status dot overlay', () => {
    it('shows green dot when connected', () => {
      const { container } = renderCard({ adapterState: 'connected' });
      expect(container.querySelector('.bg-green-500')).toBeInTheDocument();
    });

    it('shows amber dot when disconnected (dropped binding warrants attention)', () => {
      const { container } = renderCard({ adapterState: 'disconnected' });
      expect(container.querySelector('.bg-amber-500')).toBeInTheDocument();
    });

    it('shows red dot when error', () => {
      const { container } = renderCard({ adapterState: 'error' });
      expect(container.querySelector('.bg-red-500')).toBeInTheDocument();
    });

    it('shows amber pulse dot when connecting', () => {
      const { container } = renderCard({ adapterState: 'connecting' });
      expect(container.querySelector('.bg-amber-500')).toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('shows error message (not preview sentence) when adapter is in error state', () => {
      const { view } = renderCard({
        adapterState: 'error',
        errorMessage: 'Connection refused',
      });
      expect(view.getByText('Connection refused')).toBeInTheDocument();
      expect(view.queryByText('One thread for each conversation')).not.toBeInTheDocument();
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
      expect(container.querySelector('.border-red-500\\/50')).toBeInTheDocument();
    });
  });

  describe('Restricted pill', () => {
    it('does not show Restricted pill when all permissions are default', () => {
      const { view } = renderCard({
        binding: makeBinding({ canInitiate: false, canReply: true, canReceive: true }),
      });
      expect(view.queryByText('Restricted')).not.toBeInTheDocument();
    });

    it('shows Restricted pill when canInitiate is true', () => {
      const { view } = renderCard({ binding: makeBinding({ canInitiate: true }) });
      expect(view.getByText('Restricted')).toBeInTheDocument();
    });

    it('shows Restricted pill when canReply is false', () => {
      const { view } = renderCard({ binding: makeBinding({ canReply: false }) });
      expect(view.getByText('Restricted')).toBeInTheDocument();
    });

    it('shows Restricted pill when canReceive is false', () => {
      const { view } = renderCard({ binding: makeBinding({ canReceive: false }) });
      expect(view.getByText('Restricted')).toBeInTheDocument();
    });

    it('does not show per-permission icons (zap, message-square-off, bell-off)', () => {
      const { container } = renderCard({
        binding: makeBinding({ canInitiate: true, canReply: false, canReceive: false }),
      });
      expect(container.querySelector('.lucide-zap')).not.toBeInTheDocument();
      expect(container.querySelector('.lucide-message-square-off')).not.toBeInTheDocument();
      expect(container.querySelector('.lucide-bell-off')).not.toBeInTheDocument();
    });
  });

  describe('kebab menu actions', () => {
    it('renders an always-visible Actions button', () => {
      const { view } = renderCard();
      expect(view.getByRole('button', { name: 'Actions' })).toBeInTheDocument();
    });

    it('calls onEdit when Edit is clicked in the kebab menu', async () => {
      const user = userEvent.setup();
      const onEdit = vi.fn();
      const { view } = renderCard({ onEdit });
      // userEvent opens the Radix dropdown; fireEvent bypasses pointer-events:none on portal items
      await user.click(view.getByRole('button', { name: 'Actions' }));
      fireEvent.click(screen.getByText('Edit'));
      expect(onEdit).toHaveBeenCalledTimes(1);
    });

    it('shows remove confirmation dialog when Remove is clicked in the kebab menu', async () => {
      const user = userEvent.setup();
      const { view } = renderCard({ channelName: 'Telegram' });
      await user.click(view.getByRole('button', { name: 'Actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
      expect(screen.getByText('Remove channel binding')).toBeInTheDocument();
      expect(
        screen.getByText(
          /Remove the binding to Telegram\? The agent will no longer receive messages from this channel\./
        )
      ).toBeInTheDocument();
    });

    it('calls onRemove when removal is confirmed', async () => {
      // pointerEventsCheck: 0 because the AlertDialog traps pointer-events on the rest of the DOM
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      const onRemove = vi.fn();
      const { view } = renderCard({ onRemove });

      await user.click(view.getByRole('button', { name: 'Actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));

      const dialogContent = screen.getByRole('alertdialog');
      const confirmButton = within(dialogContent)
        .getAllByRole('button')
        .find((el) => el.textContent === 'Remove');
      expect(confirmButton).toBeDefined();
      fireEvent.click(confirmButton!);
      expect(onRemove).toHaveBeenCalledTimes(1);
    });

    it('does not call onRemove when Cancel is clicked in confirmation', async () => {
      // pointerEventsCheck: 0 because the AlertDialog traps pointer-events on the rest of the DOM
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      const onRemove = vi.fn();
      const { view } = renderCard({ onRemove });

      await user.click(view.getByRole('button', { name: 'Actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));

      const dialogContent = screen.getByRole('alertdialog');
      fireEvent.click(within(dialogContent).getByText('Cancel'));
      expect(onRemove).not.toHaveBeenCalled();
    });
  });

  describe('type safety', () => {
    it('accepts all four CardAdapterState values', () => {
      const states: CardAdapterState[] = ['connected', 'disconnected', 'error', 'connecting'];
      for (const adapterState of states) {
        expect(() => renderCard({ adapterState })).not.toThrow();
      }
    });
  });
});
