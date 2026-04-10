// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { CatalogEntry } from '@dorkos/shared/relay-schemas';

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
  deprecated?: boolean;
  multiInstance?: boolean;
  noInstances?: boolean;
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
      multiInstance: overrides.multiInstance ?? false,
      deprecated: overrides.deprecated,
    },
    instances: overrides.noInstances
      ? []
      : [
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
  catalog?: CatalogEntry[];
  onSelectChannel?: ReturnType<typeof vi.fn>;
  onRequestSetup?: ReturnType<typeof vi.fn>;
  boundAdapterIds?: Set<string>;
  disabled?: boolean;
}

function renderPicker(options: RenderPickerOptions = {}) {
  const props = {
    catalog: options.catalog ?? [],
    onSelectChannel: options.onSelectChannel ?? vi.fn(),
    onRequestSetup: options.onRequestSetup ?? vi.fn(),
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

    it('shows "No channels available" when catalog is empty', () => {
      const { view } = renderPicker({ catalog: [] });

      fireEvent.click(view.getByText('Connect to Channel'));
      expect(screen.getByText('No channels available')).toBeInTheDocument();
    });

    it('lists configured channels from the catalog', () => {
      const catalog = [
        makeCatalogEntry({ displayName: 'Telegram', instanceId: 'tg-1' }),
        makeCatalogEntry({
          type: 'slack',
          displayName: 'Slack',
          instanceId: 'slack-1',
        }),
      ];
      const { view } = renderPicker({ catalog });

      fireEvent.click(view.getByText('Connect to Channel'));
      expect(screen.getByText('Telegram')).toBeInTheDocument();
      expect(screen.getByText('Slack')).toBeInTheDocument();
    });

    it('shows adapter label when present', () => {
      const catalog = [makeCatalogEntry({ label: 'Work Bot' })];
      const { view } = renderPicker({ catalog });

      fireEvent.click(view.getByText('Connect to Channel'));
      expect(screen.getByText('Work Bot')).toBeInTheDocument();
    });

    it('shows channel state text', () => {
      const catalog = [makeCatalogEntry({ state: 'connected' })];
      const { view } = renderPicker({ catalog });

      fireEvent.click(view.getByText('Connect to Channel'));
      // ChannelPicker uses ADAPTER_STATE_LABEL which humanizes 'connected' → 'Connected'
      expect(screen.getByText('Connected')).toBeInTheDocument();
    });

    it('shows "Connected" text for already-bound channels', () => {
      const catalog = [makeCatalogEntry({ instanceId: 'tg-1' })];
      const { view } = renderPicker({ catalog, boundAdapterIds: new Set(['tg-1']) });

      fireEvent.click(view.getByText('Connect to Channel'));
      expect(screen.getByText('Connected')).toBeInTheDocument();
    });

    it('disables already-bound channels', () => {
      const catalog = [makeCatalogEntry({ instanceId: 'tg-1', displayName: 'Telegram' })];
      const { view } = renderPicker({ catalog, boundAdapterIds: new Set(['tg-1']) });

      fireEvent.click(view.getByText('Connect to Channel'));
      const channelButton = screen.getByText('Telegram').closest('button');
      expect(channelButton).toBeDisabled();
    });

    it('disables channels in error state', () => {
      const catalog = [makeCatalogEntry({ state: 'error', displayName: 'Broken Bot' })];
      const { view } = renderPicker({ catalog });

      fireEvent.click(view.getByText('Connect to Channel'));
      const channelButton = screen.getByText('Broken Bot').closest('button');
      expect(channelButton).toBeDisabled();
    });

    it('disables channels that are not enabled', () => {
      const catalog = [makeCatalogEntry({ enabled: false, displayName: 'Disabled Bot' })];
      const { view } = renderPicker({ catalog });

      fireEvent.click(view.getByText('Connect to Channel'));
      const channelButton = screen.getByText('Disabled Bot').closest('button');
      expect(channelButton).toBeDisabled();
    });

    it('calls onSelectChannel when a channel is clicked', () => {
      const catalog = [makeCatalogEntry({ instanceId: 'tg-1', displayName: 'Telegram' })];
      const onSelectChannel = vi.fn();
      const { view } = renderPicker({ catalog, onSelectChannel });

      fireEvent.click(view.getByText('Connect to Channel'));
      fireEvent.click(screen.getByText('Telegram'));
      expect(onSelectChannel).toHaveBeenCalledWith('tg-1');
    });

    it('closes popover after selecting a channel', () => {
      const catalog = [makeCatalogEntry({ instanceId: 'tg-1', displayName: 'Telegram' })];
      const { view } = renderPicker({ catalog });

      fireEvent.click(view.getByText('Connect to Channel'));
      fireEvent.click(screen.getByText('Telegram'));
      // After selection, popover should close — channel name should no longer be in portal
      expect(screen.queryByText('Telegram')).not.toBeInTheDocument();
    });
  });

  describe('available to set up section', () => {
    it('shows "Available to set up" section for entries with no instances', () => {
      const catalog = [makeCatalogEntry({ displayName: 'Webhook', noInstances: true })];
      const { view } = renderPicker({ catalog });

      fireEvent.click(view.getByText('Connect to Channel'));
      expect(screen.getByText('Available to set up')).toBeInTheDocument();
      expect(screen.getByText('Webhook')).toBeInTheDocument();
    });

    it('shows "Available to set up" for multiInstance entries', () => {
      const catalog = [
        makeCatalogEntry({ displayName: 'Telegram', multiInstance: true, instanceId: 'tg-1' }),
      ];
      const { view } = renderPicker({ catalog });

      fireEvent.click(view.getByText('Connect to Channel'));
      expect(screen.getByText('Available to set up')).toBeInTheDocument();
    });

    it('does not show deprecated entries in "Available to set up"', () => {
      const catalog = [
        makeCatalogEntry({ displayName: 'Old Bot', deprecated: true, noInstances: true }),
      ];
      const { view } = renderPicker({ catalog });

      fireEvent.click(view.getByText('Connect to Channel'));
      expect(screen.queryByText('Available to set up')).not.toBeInTheDocument();
    });

    it('calls onRequestSetup when a setup entry is clicked', () => {
      const catalog = [makeCatalogEntry({ displayName: 'Webhook', noInstances: true })];
      const onRequestSetup = vi.fn();
      const { view } = renderPicker({ catalog, onRequestSetup });

      fireEvent.click(view.getByText('Connect to Channel'));
      fireEvent.click(screen.getByText('Webhook'));
      expect(onRequestSetup).toHaveBeenCalledWith(catalog[0].manifest);
    });

    it('closes popover before calling onRequestSetup', () => {
      const catalog = [makeCatalogEntry({ displayName: 'Webhook', noInstances: true })];
      const onRequestSetup = vi.fn();
      const { view } = renderPicker({ catalog, onRequestSetup });

      fireEvent.click(view.getByText('Connect to Channel'));
      fireEvent.click(screen.getByText('Webhook'));
      // The popover should close — the "Available to set up" text should not be visible
      expect(screen.queryByText('Available to set up')).not.toBeInTheDocument();
    });
  });
});
