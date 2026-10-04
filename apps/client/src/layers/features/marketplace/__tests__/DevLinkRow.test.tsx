/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InstalledPackage } from '@dorkos/shared/marketplace-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';

// Capture the event handler so the test can deliver the server's event.
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useEventSubscription: vi.fn(),
}));

import { TransportProvider, useEventSubscription } from '@/layers/shared/model';
import { useDevLinkReloadStore, useDevLinkReloadSync } from '@/layers/entities/marketplace';
import { DevLinkActionButtons, DevLinkDetails } from '../ui/DevLinkRow';

const NOW = Date.parse('2026-10-03T12:00:10.000Z');

function row(overrides: Partial<InstalledPackage> = {}): InstalledPackage {
  return {
    name: 'flow',
    version: '1.0.0',
    type: 'plugin',
    installPath: '/home/me/.dork/plugins/flow',
    scope: 'global',
    devLink: { path: '/work/flow', state: 'active', parked: false },
    ...overrides,
  } as InstalledPackage;
}

let transport: Transport;

function Harness({ installation }: { installation: InstalledPackage }) {
  useDevLinkReloadSync();
  return <DevLinkDetails installation={installation} />;
}

function renderWith(children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  transport = createMockTransport();
  useDevLinkReloadStore.setState({ latest: {} });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('DevLinkDetails', () => {
  it('shows the folder path and updates "Reloaded" when the reload event arrives', async () => {
    // Purpose: the global stream's event drives the row's status line (spec §6).
    let deliver: ((data: unknown) => void) | undefined;
    vi.mocked(useEventSubscription).mockImplementation((name, handler) => {
      if (name === 'marketplace_dev_link_reloaded') deliver = handler;
    });
    renderWith(<Harness installation={row()} />);

    expect(screen.getByText('/work/flow')).toBeVisible();
    expect(await screen.findByText('Watching for edits.')).toBeVisible();

    act(() =>
      deliver!({
        name: 'flow',
        scope: 'global',
        at: '2026-10-03T12:00:06.000Z',
        actions: ['extension'],
      })
    );
    expect(await screen.findByText('Reloaded 4s ago')).toBeVisible();

    act(() =>
      deliver!({
        name: 'flow',
        scope: 'global',
        at: '2026-10-03T12:00:09.000Z',
        actions: ['extension'],
        errors: ["flow-dashboard didn't build: Unexpected token"],
      })
    );
    expect(
      await screen.findByText('Couldn’t reload: flow-dashboard has a build error.')
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Details' })).toBeVisible();
  });

  it('ignores a reload of a different dev link', async () => {
    // Purpose: an event names one link; another package's row is untouched.
    let deliver: ((data: unknown) => void) | undefined;
    vi.mocked(useEventSubscription).mockImplementation((_name, handler) => {
      deliver = handler;
    });
    renderWith(<Harness installation={row()} />);
    await screen.findByText('Watching for edits.');
    act(() =>
      deliver!({ name: 'other', scope: 'global', at: '2026-10-03T12:00:06.000Z', actions: [] })
    );
    expect(screen.getByText('Watching for edits.')).toBeVisible();
  });

  it('says the folder is missing', async () => {
    renderWith(
      <DevLinkDetails
        installation={row({
          devLink: { path: '/work/flow', state: 'folder-missing', parked: false },
        })}
      />
    );
    expect(await screen.findByText('Folder missing. Restore it or unlink.')).toBeVisible();
  });
});

describe('DevLinkActionButtons', () => {
  const noop = () => undefined;

  it('offers only "Use installed copy" when an installed copy is set aside', () => {
    // Purpose: with a parked copy, unlinking IS using the installed copy.
    render(
      <DevLinkActionButtons
        installation={row({ devLink: { path: '/w', state: 'active', parked: true } })}
        label="Flow"
        onUnlink={noop}
        onInstallPublished={noop}
      />
    );
    expect(screen.getByRole('button', { name: 'Use the installed copy of Flow' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Unlink Flow' })).toBeNull();
  });

  it('offers "Install published version" only for a package a marketplace lists', () => {
    // Purpose: never offer an install that has nothing to install.
    const { rerender } = render(
      <DevLinkActionButtons
        installation={row()}
        label="Flow"
        onUnlink={noop}
        onInstallPublished={noop}
      />
    );
    expect(screen.queryByText('Install published version')).toBeNull();
    expect(screen.getByRole('button', { name: 'Unlink Flow' })).toBeVisible();
    rerender(
      <DevLinkActionButtons
        installation={row()}
        published={{ name: 'flow', source: 'x', marketplace: 'dorkos' } as never}
        label="Flow"
        onUnlink={noop}
        onInstallPublished={noop}
      />
    );
    expect(screen.getByText('Install published version')).toBeVisible();
  });
});
