// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import type { StatusBarPrefs } from '@dorkos/shared/config-schema';
import { STATUS_BAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';
import { StatusBarConfigureContent } from '../ui/StatusBarConfigureContent';
import { STATUS_BAR_REGISTRY } from '../model/status-bar-registry';

// Mock Radix Switch as a simple button with role="switch" to avoid the void-element
// constraint on <input> when Radix passes children (Thumb) into the Root.
vi.mock('@radix-ui/react-switch', () => ({
  Root: ({
    checked,
    onCheckedChange,
    'aria-label': ariaLabel,
    children,
    ...props
  }: {
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
    'aria-label'?: string;
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <button
      role="switch"
      aria-label={ariaLabel}
      aria-checked={checked ?? false}
      onClick={() => onCheckedChange?.(!checked)}
      {...props}
    >
      {children}
    </button>
  ),
  Thumb: () => null,
}));

function makeServerConfig(statusBar: StatusBarPrefs): ServerConfig {
  return { ui: { statusBar } } as unknown as ServerConfig;
}

function renderContent(overrides: Partial<StatusBarPrefs> = {}, transport?: Transport) {
  const t =
    transport ?? createMockTransport({ updateConfig: vi.fn().mockResolvedValue(undefined) });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(
    configKeys.current(),
    makeServerConfig({ ...STATUS_BAR_PREFS_DEFAULTS, ...overrides })
  );
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={t}>
        <StatusBarConfigureContent />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport: t, queryClient };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StatusBarConfigureContent', () => {
  it('renders all registry item labels', () => {
    renderContent();
    for (const item of STATUS_BAR_REGISTRY) {
      expect(screen.getByText(item.label)).toBeInTheDocument();
    }
  });

  it('renders all item descriptions', () => {
    renderContent();
    for (const item of STATUS_BAR_REGISTRY) {
      expect(screen.getByText(item.description)).toBeInTheDocument();
    }
  });

  it('renders a switch for every registry item', () => {
    renderContent();
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(STATUS_BAR_REGISTRY.length);
  });

  it('renders the two group headers: Session Info, Controls', () => {
    renderContent();
    expect(screen.getByText('Session Info')).toBeInTheDocument();
    expect(screen.getByText('Controls')).toBeInTheDocument();
  });

  it('renders a "Reset to defaults" button', () => {
    renderContent();
    expect(screen.getByRole('button', { name: 'Reset to defaults' })).toBeInTheDocument();
  });

  it('shows switches as checked when items are visible', () => {
    renderContent();
    const cwdSwitch = screen.getByRole('switch', { name: 'Toggle Directory' });
    expect(cwdSwitch).toHaveAttribute('aria-checked', 'true');
  });

  it('shows switch as unchecked when the config hides the item', () => {
    renderContent({ git: false });
    const gitSwitch = screen.getByRole('switch', { name: 'Toggle Git Status' });
    expect(gitSwitch).toHaveAttribute('aria-checked', 'false');
  });

  it('toggling a switch PATCHes the config with the single key', async () => {
    const { transport } = renderContent();
    const modelSwitch = screen.getByRole('switch', { name: 'Toggle Model' });

    fireEvent.click(modelSwitch);

    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({ ui: { statusBar: { model: false } } })
    );
  });

  it('toggling a hidden item back on PATCHes it true', async () => {
    const { transport } = renderContent({ usage: false });
    const usageSwitch = screen.getByRole('switch', { name: 'Toggle Usage & cost' });

    fireEvent.click(usageSwitch);

    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({ ui: { statusBar: { usage: true } } })
    );
  });

  it('clicking "Reset to defaults" PATCHes the full defaults section', async () => {
    const { transport } = renderContent({ cwd: false, git: false });

    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));

    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        ui: { statusBar: STATUS_BAR_PREFS_DEFAULTS },
      })
    );
  });

  it('has aria-label="Status bar configuration" on the root container', () => {
    renderContent();
    expect(screen.getByRole('generic', { name: 'Status bar configuration' })).toBeInTheDocument();
  });
});
