/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { AdapterManifest, CatalogInstance } from '@dorkos/shared/relay-schemas';

// Mock AdapterIcon — avoid deep relay feature dependency
vi.mock('@/layers/features/relay', () => ({
  AdapterIcon: ({ adapterType }: { adapterType: string }) => (
    <span data-testid="adapter-icon">{adapterType}</span>
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

afterEach(cleanup);

import { ChannelSettingRow } from '../ui/ChannelSettingRow';

function createManifest(overrides?: Partial<AdapterManifest>): AdapterManifest {
  return {
    type: 'telegram',
    displayName: 'Telegram',
    description: 'Telegram Bot adapter',
    category: 'messaging',
    builtin: true,
    configFields: [],
    multiInstance: false,
    ...overrides,
  };
}

function createInstance(overrides?: Partial<CatalogInstance>): CatalogInstance {
  return {
    id: 'telegram-1',
    enabled: true,
    label: 'My Telegram Bot',
    status: {
      id: 'telegram-1',
      type: 'telegram',
      displayName: 'Telegram',
      state: 'connected',
      messageCount: { inbound: 10, outbound: 5 },
      errorCount: 0,
    },
    ...overrides,
  };
}

describe('ChannelSettingRow', () => {
  it('renders the instance label as display name', () => {
    const manifest = createManifest();
    const instance = createInstance({ label: 'Production Bot' });

    render(
      <ChannelSettingRow
        instance={instance}
        manifest={manifest}
        onToggle={vi.fn()}
        onConfigure={vi.fn()}
      />
    );

    expect(screen.getByText('Production Bot')).toBeInTheDocument();
  });

  it('falls back to status displayName when label is absent', () => {
    const manifest = createManifest();
    const instance = createInstance({ label: undefined });

    render(
      <ChannelSettingRow
        instance={instance}
        manifest={manifest}
        onToggle={vi.fn()}
        onConfigure={vi.fn()}
      />
    );

    expect(screen.getByText('Telegram')).toBeInTheDocument();
  });

  it('falls back to instance id when both label and displayName are absent', () => {
    const manifest = createManifest();
    const instance = createInstance({
      id: 'tg-custom',
      label: undefined,
      status: {
        id: 'tg-custom',
        type: 'telegram',
        displayName: '',
        state: 'connected',
        messageCount: { inbound: 0, outbound: 0 },
        errorCount: 0,
      },
    });

    render(
      <ChannelSettingRow
        instance={instance}
        manifest={manifest}
        onToggle={vi.fn()}
        onConfigure={vi.fn()}
      />
    );

    expect(screen.getByText('tg-custom')).toBeInTheDocument();
  });

  it('renders the enabled switch reflecting instance enabled state', () => {
    const manifest = createManifest();
    const instance = createInstance({ enabled: true });

    render(
      <ChannelSettingRow
        instance={instance}
        manifest={manifest}
        onToggle={vi.fn()}
        onConfigure={vi.fn()}
      />
    );

    const toggle = screen.getByRole('switch', { name: /my telegram bot enabled/i });
    expect(toggle).toBeInTheDocument();
    expect(toggle.getAttribute('data-state')).toBe('checked');
  });

  it('renders the switch as unchecked when instance is disabled', () => {
    const manifest = createManifest();
    const instance = createInstance({ enabled: false });

    render(
      <ChannelSettingRow
        instance={instance}
        manifest={manifest}
        onToggle={vi.fn()}
        onConfigure={vi.fn()}
      />
    );

    const toggle = screen.getByRole('switch', { name: /my telegram bot enabled/i });
    expect(toggle.getAttribute('data-state')).toBe('unchecked');
  });

  it('calls onToggle when the switch is clicked', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const manifest = createManifest();
    const instance = createInstance({ enabled: false });

    render(
      <ChannelSettingRow
        instance={instance}
        manifest={manifest}
        onToggle={onToggle}
        onConfigure={vi.fn()}
      />
    );

    await user.click(screen.getByRole('switch', { name: /my telegram bot enabled/i }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('renders the configure button with accessible label', () => {
    const manifest = createManifest();
    const instance = createInstance({ label: 'My Telegram Bot' });

    render(
      <ChannelSettingRow
        instance={instance}
        manifest={manifest}
        onToggle={vi.fn()}
        onConfigure={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /configure my telegram bot/i })).toBeInTheDocument();
  });

  it('calls onConfigure when the configure button is clicked', async () => {
    const user = userEvent.setup();
    const onConfigure = vi.fn();
    const manifest = createManifest();
    const instance = createInstance();

    render(
      <ChannelSettingRow
        instance={instance}
        manifest={manifest}
        onToggle={vi.fn()}
        onConfigure={onConfigure}
      />
    );

    await user.click(screen.getByRole('button', { name: /configure my telegram bot/i }));
    expect(onConfigure).toHaveBeenCalledOnce();
  });

  it('renders the adapter icon for the manifest type', () => {
    const manifest = createManifest({ type: 'slack' });
    const instance = createInstance();

    render(
      <ChannelSettingRow
        instance={instance}
        manifest={manifest}
        onToggle={vi.fn()}
        onConfigure={vi.fn()}
      />
    );

    expect(screen.getByTestId('adapter-icon')).toHaveTextContent('slack');
  });
});
