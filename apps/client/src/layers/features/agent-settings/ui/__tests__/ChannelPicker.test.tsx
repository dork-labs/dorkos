// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { CatalogEntry } from '@dorkos/shared/relay-schemas';

// --- Mocks (before imports that use them) ---

const mockUseRelayEnabled = vi.fn<() => boolean>(() => true);
const mockUseAdapterCatalog = vi.fn<() => { data: CatalogEntry[] }>(() => ({ data: [] }));

vi.mock('@/layers/entities/relay', () => ({
  useRelayEnabled: () => mockUseRelayEnabled(),
  useAdapterCatalog: () => mockUseAdapterCatalog(),
}));

import { ChannelPicker } from '../ChannelPicker';

// --- Test helpers ---

/** Build a minimal CatalogEntry with one instance. */
function makeCatalogEntry(overrides: {
  type?: string;
  displayName?: string;
  instanceId?: string;
  instanceDisplayName?: string;
  state?: 'connected' | 'disconnected' | 'error' | 'starting' | 'stopping' | 'reconnecting';
  enabled?: boolean;
  label?: string;
}): CatalogEntry {
  const type = (overrides.type ?? 'telegram') as CatalogEntry['manifest']['type'];
  const id = overrides.instanceId ?? `${type}-1`;
  return {
    manifest: {
      type,
      displayName: overrides.displayName ?? 'Telegram',
      description: 'Test adapter',
      category: 'messaging',
      builtin: true,
      configFields: [],
      multiInstance: false,
    },
    instances: [
      {
        id,
        enabled: overrides.enabled ?? true,
        label: overrides.label,
        status: {
          id,
          type: type as 'telegram',
          displayName: overrides.instanceDisplayName ?? overrides.displayName ?? 'Telegram',
          state: overrides.state ?? 'connected',
          messageCount: { inbound: 0, outbound: 0 },
          errorCount: 0,
        },
      },
    ],
  };
}

interface RenderPickerOptions {
  onSelectChannel?: ReturnType<typeof vi.fn>;
  onSetupNewChannel?: ReturnType<typeof vi.fn>;
  boundAdapterIds?: Set<string>;
  disabled?: boolean;
}

function renderPicker(options: RenderPickerOptions = {}) {
  const props = {
    onSelectChannel: options.onSelectChannel ?? vi.fn(),
    onSetupNewChannel: options.onSetupNewChannel ?? vi.fn(),
    boundAdapterIds: options.boundAdapterIds ?? new Set<string>(),
    disabled: options.disabled,
  };
  const { container } = render(<ChannelPicker {...props} />);
  return { view: within(container), container, ...props };
}

// --- Tests ---

describe('ChannelPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRelayEnabled.mockReturnValue(true);
    mockUseAdapterCatalog.mockReturnValue({ data: [] });
  });

  it('renders a "Connect to Channel" button', () => {
    const { view } = renderPicker();
    expect(view.getByText('Connect to Channel')).toBeInTheDocument();
  });

  it('disables the button when disabled prop is true', () => {
    const { view } = renderPicker({ disabled: true });
    expect(view.getByText('Connect to Channel').closest('button')).toBeDisabled();
  });

  describe('popover content', () => {
    // PopoverContent renders via Radix portal — use screen for portal queries.

    it('shows "No channels configured" when catalog is empty', () => {
      mockUseAdapterCatalog.mockReturnValue({ data: [] });
      const { view } = renderPicker();

      fireEvent.click(view.getByText('Connect to Channel'));
      expect(screen.getByText('No channels configured')).toBeInTheDocument();
    });

    it('lists configured channels from the catalog', () => {
      mockUseAdapterCatalog.mockReturnValue({
        data: [
          makeCatalogEntry({ displayName: 'Telegram', instanceId: 'tg-1' }),
          makeCatalogEntry({
            type: 'slack',
            displayName: 'Slack',
            instanceId: 'slack-1',
          }),
        ],
      });
      const { view } = renderPicker();

      fireEvent.click(view.getByText('Connect to Channel'));
      expect(screen.getByText('Telegram')).toBeInTheDocument();
      expect(screen.getByText('Slack')).toBeInTheDocument();
    });

    it('shows adapter label when present', () => {
      mockUseAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ label: 'Work Bot' })],
      });
      const { view } = renderPicker();

      fireEvent.click(view.getByText('Connect to Channel'));
      expect(screen.getByText('Work Bot')).toBeInTheDocument();
    });

    it('shows channel state text', () => {
      mockUseAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ state: 'connected' })],
      });
      const { view } = renderPicker();

      fireEvent.click(view.getByText('Connect to Channel'));
      expect(screen.getByText('connected')).toBeInTheDocument();
    });

    it('shows "connected" text for already-bound channels', () => {
      mockUseAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'tg-1' })],
      });
      const { view } = renderPicker({ boundAdapterIds: new Set(['tg-1']) });

      fireEvent.click(view.getByText('Connect to Channel'));
      expect(screen.getByText('connected')).toBeInTheDocument();
    });

    it('disables already-bound channels', () => {
      mockUseAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'tg-1', displayName: 'Telegram' })],
      });
      const { view } = renderPicker({ boundAdapterIds: new Set(['tg-1']) });

      fireEvent.click(view.getByText('Connect to Channel'));
      const channelButton = screen.getByText('Telegram').closest('button');
      expect(channelButton).toBeDisabled();
    });

    it('disables channels in error state', () => {
      mockUseAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ state: 'error', displayName: 'Broken Bot' })],
      });
      const { view } = renderPicker();

      fireEvent.click(view.getByText('Connect to Channel'));
      const channelButton = screen.getByText('Broken Bot').closest('button');
      expect(channelButton).toBeDisabled();
    });

    it('disables channels that are not enabled', () => {
      mockUseAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ enabled: false, displayName: 'Disabled Bot' })],
      });
      const { view } = renderPicker();

      fireEvent.click(view.getByText('Connect to Channel'));
      const channelButton = screen.getByText('Disabled Bot').closest('button');
      expect(channelButton).toBeDisabled();
    });

    it('calls onSelectChannel when a channel is clicked', () => {
      mockUseAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'tg-1', displayName: 'Telegram' })],
      });
      const onSelectChannel = vi.fn();
      const { view } = renderPicker({ onSelectChannel });

      fireEvent.click(view.getByText('Connect to Channel'));
      fireEvent.click(screen.getByText('Telegram'));
      expect(onSelectChannel).toHaveBeenCalledWith('tg-1');
    });

    it('closes popover after selecting a channel', () => {
      mockUseAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'tg-1', displayName: 'Telegram' })],
      });
      const { view } = renderPicker();

      fireEvent.click(view.getByText('Connect to Channel'));
      fireEvent.click(screen.getByText('Telegram'));
      // After selection, popover should close — channel name should no longer be in portal
      expect(screen.queryByText('Set up a new channel...')).not.toBeInTheDocument();
    });
  });

  describe('setup new channel footer', () => {
    it('shows "Set up a new channel..." link', () => {
      const { view } = renderPicker();

      fireEvent.click(view.getByText('Connect to Channel'));
      expect(screen.getByText('Set up a new channel...')).toBeInTheDocument();
    });

    it('calls onSetupNewChannel when clicked', () => {
      const onSetupNewChannel = vi.fn();
      const { view } = renderPicker({ onSetupNewChannel });

      fireEvent.click(view.getByText('Connect to Channel'));
      fireEvent.click(screen.getByText('Set up a new channel...'));
      expect(onSetupNewChannel).toHaveBeenCalledTimes(1);
    });
  });
});
