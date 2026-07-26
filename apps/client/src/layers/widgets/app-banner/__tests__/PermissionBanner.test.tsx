/**
 * @vitest-environment jsdom
 *
 * These tests never seed the query cache with a hand-written key. They stand up
 * the REAL session hooks over a mock transport and assert on what a person would
 * see on screen, because the defect this suite exists to catch (DOR-482) was a
 * reader and a writer disagreeing about which cache entry holds the session: the
 * banner read `['session', id]` while every session hook writes
 * `['session', id, cwd]`. A test that seeded the key the reader happened to read
 * would have stayed green through the entire outage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PermissionMode, Session } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';

// The working directory is part of the session cache key. Pinning it to a real
// path (rather than null) is deliberate: a reader that rebuilt the key by hand
// and guessed the cwd would still miss the entry the writer created.
const fixtures = vi.hoisted(() => ({
  selectedCwd: '/Users/dev/work/dorkos',
  /** Drives `useSafePathname` — the banner only fetches on the session route. */
  pathname: '/session',
}));
const SELECTED_CWD = fixtures.selectedCwd;

vi.mock('@/layers/shared/model/app-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model/app-store')>()),
  useAppStore: vi.fn((selector: (s: { selectedCwd: string | null }) => unknown) =>
    selector({ selectedCwd: fixtures.selectedCwd })
  ),
}));

vi.mock('@/layers/shared/model/use-safe-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model/use-safe-router')>()),
  useSafePathname: () => fixtures.pathname,
}));

import { TransportProvider } from '@/layers/shared/model';
import {
  useSessionStatus,
  useSessionSettingsOverridesStore,
  sessionKeys,
} from '@/layers/entities/session';
import { PermissionBanner } from '../ui/PermissionBanner';

/** A session row shaped the way the server reports one. */
function sessionRow(permissionMode: PermissionMode): Session {
  return {
    id: 's1',
    cwd: SELECTED_CWD,
    model: 'claude-opus-4-6',
    permissionMode,
  } as Session;
}

/** One QueryClient per render, exposed so a test can inspect what was written. */
function harness(transport: Transport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

/**
 * The hook every chat surface mounts to read and write a session's settings —
 * and the only thing that populates the session cache in the running app. It
 * renders its own view of the permission mode so a failing assertion about the
 * banner can be told apart from a broken fixture.
 */
function SessionStatusProbe({ sessionId }: { sessionId: string }) {
  const { permissionMode } = useSessionStatus(sessionId, null, false);
  return <span data-testid="probe">{`mode:${permissionMode}`}</span>;
}

/** Render the writer and the banner side by side, exactly as the app shell does. */
function renderBanner(mode: PermissionMode | null, sessionId: string | null = 's1') {
  const transport = createMockTransport({
    getSession: vi.fn().mockResolvedValue(mode ? sessionRow(mode) : undefined),
    getModels: vi.fn().mockResolvedValue([]),
    updateSession: vi.fn().mockResolvedValue({ permissionMode: 'bypassPermissions' }),
  });
  const { queryClient, wrapper } = harness(transport);
  const result = render(
    <>
      {sessionId && <SessionStatusProbe sessionId={sessionId} />}
      <PermissionBanner sessionId={sessionId} />
    </>,
    { wrapper }
  );
  return { ...result, transport, queryClient };
}

describe('PermissionBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixtures.pathname = '/session';
    // Module-level store — one test's pending change must not bleed into the next.
    useSessionSettingsOverridesStore.setState({ bySession: {} });
  });
  afterEach(cleanup);

  it('warns off the same session cache the session hooks write', async () => {
    renderBanner('bypassPermissions');

    // Ground truth first: the session hooks HAVE resolved this session as
    // bypassing. If this line passes and the next one fails, the two surfaces
    // are reading different cache entries for one session — the DOR-482 defect.
    await screen.findByText('mode:bypassPermissions');

    const banner = await screen.findByRole('status');
    expect(banner).toHaveAttribute('data-variant', 'warning');
    expect(banner).toHaveTextContent('All permissions bypassed');
  });

  it('appears the moment the person switches the session into bypass', async () => {
    // The banner is a live safety signal, not a mount-time snapshot. Reading the
    // cache without subscribing to it would leave this red: the value changes
    // and nothing re-renders the banner.
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue(sessionRow('default')),
      getModels: vi.fn().mockResolvedValue([]),
      updateSession: vi.fn().mockResolvedValue({ permissionMode: 'bypassPermissions' }),
    });
    /** Stands in for the permission-mode picker in the status line. */
    function Writer() {
      const { permissionMode, updateSession } = useSessionStatus('s1', null, false);
      return (
        <>
          <span data-testid="probe">{`mode:${permissionMode}`}</span>
          <button
            type="button"
            onClick={() => void updateSession({ permissionMode: 'bypassPermissions' })}
          >
            Bypass All
          </button>
        </>
      );
    }

    const { queryClient, wrapper } = harness(transport);
    render(
      <>
        <Writer />
        <PermissionBanner sessionId="s1" />
      </>,
      { wrapper }
    );

    await screen.findByText('mode:default');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Bypass All' }));

    expect(await screen.findByRole('status')).toHaveTextContent('All permissions bypassed');

    // The banner above could be riding the optimistic override alone, which lives
    // in Zustand and never touches the cache. Assert the confirmed write landed
    // on the shared key too — otherwise the writer's `setQueryData` key could
    // drift to anything and the whole suite would stay green.
    await waitFor(() =>
      expect(queryClient.getQueryData(sessionKeys.detail('s1', SELECTED_CWD))).toMatchObject({
        permissionMode: 'bypassPermissions',
      })
    );
    // And nothing is written to the key the broken reader used to look at.
    expect(queryClient.getQueryData(sessionKeys.bySession('s1'))).toBeUndefined();
  });

  it('does not fetch a session row on a page that shows no session', async () => {
    // The banner reports on the session cache; it must not be the surface that
    // goes and populates it for `/agents` or `/marketplace`, which display
    // nothing about the session.
    fixtures.pathname = '/agents';
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue(sessionRow('bypassPermissions')),
      getModels: vi.fn().mockResolvedValue([]),
    });
    const { queryClient, wrapper } = harness(transport);
    const { rerender } = render(<PermissionBanner sessionId="s1" />, { wrapper });

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(transport.getSession).not.toHaveBeenCalled();

    // It still warns off a cache another surface already filled — the gate stops
    // it fetching, not reading.
    queryClient.setQueryData(
      sessionKeys.detail('s1', SELECTED_CWD),
      sessionRow('bypassPermissions')
    );
    rerender(<PermissionBanner sessionId="s1" />);
    expect(await screen.findByRole('status')).toHaveTextContent('All permissions bypassed');
    expect(transport.getSession).not.toHaveBeenCalled();
  });

  it('stays silent when no session is selected', async () => {
    const { container } = renderBanner(null, null);
    expect(container).toBeEmptyDOMElement();
  });

  it('stays silent before the session has loaded', async () => {
    renderBanner(null);
    await screen.findByText('mode:default');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it.each<PermissionMode>(['default', 'acceptEdits', 'plan'])(
    'stays silent in %s mode — every permission still gets asked',
    async (mode) => {
      renderBanner(mode);
      await screen.findByText(`mode:${mode}`);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    }
  );
});
