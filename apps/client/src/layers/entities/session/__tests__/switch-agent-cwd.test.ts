import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { Session } from '@dorkos/shared/types';
import {
  executeUiCommand,
  type DispatcherContext,
  type DispatcherStore,
} from '@/layers/shared/lib';
import { switchAgentCwd, type SwitchAgentCwdStore } from '../lib/switch-agent-cwd';
import type { CockpitLocation } from '../lib/session-navigation-intent';
import { sessionKeys } from '../api/query-keys';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeStore(overrides: Partial<SwitchAgentCwdStore> = {}): SwitchAgentCwdStore {
  return {
    setSelectedCwd: vi.fn(),
    ...overrides,
  };
}

/** Seed the sessions cache for a directory with a minimal Session shape. */
function seedSession(queryClient: QueryClient, dir: string, id: string): void {
  queryClient.setQueryData(sessionKeys.list(dir), [{ id }] as Session[]);
}

/**
 * A transport that knows of no sessions. The switch asks it whenever the cache
 * has nothing for the target directory, which is the ordinary case for an agent
 * this window has not opened (DOR-928).
 */
function makeTransport(sessions: Session[] = []): Transport {
  return createMockTransport({
    listSessions: vi.fn().mockResolvedValue({ sessions }),
  }) as Transport;
}

describe('switchAgentCwd', () => {
  it('persists the target directory as the selected cwd', async () => {
    const store = makeStore();
    const navigate = vi.fn();
    await switchAgentCwd('/home/user/project', {
      store,
      queryClient: new QueryClient(),
      transport: makeTransport(),
      currentLocation: () => ({ pathname: '/session', search: {} }),
      navigate,
    });
    expect(store.setSelectedCwd).toHaveBeenCalledWith('/home/user/project');
  });

  it('navigates reusing the most-recent cached session for the directory', async () => {
    const queryClient = new QueryClient();
    seedSession(queryClient, '/home/user/project', 'sess-cached');
    const navigate = vi.fn();
    await switchAgentCwd('/home/user/project', {
      store: makeStore(),
      queryClient,
      transport: makeTransport(),
      currentLocation: () => ({ pathname: '/session', search: {} }),
      navigate,
    });
    expect(navigate).toHaveBeenCalledWith({ dir: '/home/user/project', session: 'sess-cached' });
  });

  it('resumes a session the server knows about but this window never cached', async () => {
    // The reported bug at this seam: an agent-issued switch to a directory the
    // window has not displayed used to open a brand-new empty chat (DOR-928).
    const navigate = vi.fn();
    await switchAgentCwd('/home/user/project', {
      store: makeStore(),
      queryClient: new QueryClient(),
      transport: makeTransport([{ id: 'sess-on-server' } as Session]),
      currentLocation: () => ({ pathname: '/session', search: {} }),
      navigate,
    });
    expect(navigate).toHaveBeenCalledWith({
      dir: '/home/user/project',
      session: 'sess-on-server',
    });
  });

  it('commits the cwd only once it knows where it is going', async () => {
    // The chat stream is keyed on (sessionId, selectedCwd). Committing the new
    // cwd while the lookup is still out attaches the OLD session id under the
    // NEW directory, and the server resolves history from `?cwd=` — so for the
    // length of the request the client is asking the wrong project for the
    // wrong transcript.
    const store = makeStore();
    const order: string[] = [];
    store.setSelectedCwd = vi.fn(() => order.push('store'));
    let answer!: (value: { sessions: Session[] }) => void;
    const transport = createMockTransport({
      listSessions: vi.fn(
        () =>
          new Promise<{ sessions: Session[] }>((resolve) => {
            answer = resolve;
          })
      ),
    }) as Transport;

    const pending = switchAgentCwd('/home/user/new', {
      store,
      queryClient: new QueryClient(),
      transport,
      currentLocation: () => ({ pathname: '/session', search: {} }),
      navigate: () => order.push('navigate'),
    });

    expect(order).toEqual([]); // nothing committed while the lookup is out
    answer({ sessions: [{ id: 'sess-1' } as Session] });
    await pending;
    expect(order).toEqual(['store', 'navigate']);
  });

  it('leaves the cockpit where it is when the lookup fails', async () => {
    const store = makeStore();
    const navigate = vi.fn();
    const transport = createMockTransport({
      listSessions: vi.fn().mockRejectedValue(new Error('offline')),
    }) as Transport;

    await switchAgentCwd('/home/user/new', {
      store,
      queryClient: new QueryClient(),
      transport,
      currentLocation: () => ({ pathname: '/session', search: {} }),
      navigate,
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(store.setSelectedCwd).not.toHaveBeenCalled();
  });

  it('does nothing when the cockpit navigated elsewhere while the lookup was out', async () => {
    // The switch does not have to be told; it reads the router's own location,
    // so ANY navigation — a channel, a thread, a Recent row — cancels it.
    const store = makeStore();
    const navigate = vi.fn();
    let answer!: (value: { sessions: Session[] }) => void;
    let location: CockpitLocation = {
      pathname: '/session',
      search: { dir: '/home/user/old' },
    };
    const transport = createMockTransport({
      listSessions: vi.fn(
        () =>
          new Promise<{ sessions: Session[] }>((resolve) => {
            answer = resolve;
          })
      ),
    }) as Transport;

    const pending = switchAgentCwd('/home/user/project', {
      store,
      queryClient: new QueryClient(),
      transport,
      currentLocation: () => location,
      navigate,
    });
    location = { pathname: '/channels', search: { id: 'c1' } }; // somebody opened a channel
    answer({ sessions: [{ id: 'sess-1' } as Session] });
    await pending;

    expect(navigate).not.toHaveBeenCalled();
    expect(store.setSelectedCwd).not.toHaveBeenCalled();
  });

  it('proceeds when the URL was only rewritten in place while the lookup was out', () => {
    // The inverse of the test above (DOR-931): opening Settings mid-lookup rewrites
    // the URL but goes nowhere. The rewrite declares itself by stamping the
    // destination it hangs off into history state, so the switch is NOT cancelled.
    const store = makeStore();
    const navigate = vi.fn();
    let answer!: (value: { sessions: Session[] }) => void;
    let location: CockpitLocation = {
      pathname: '/session',
      search: { dir: '/home/user/old' },
    };
    const transport = createMockTransport({
      listSessions: vi.fn(
        () =>
          new Promise<{ sessions: Session[] }>((resolve) => {
            answer = resolve;
          })
      ),
    }) as Transport;

    const pending = switchAgentCwd('/home/user/project', {
      store,
      queryClient: new QueryClient(),
      transport,
      currentLocation: () => location,
      navigate,
    });
    // Settings opened in place: the URL grew `?settings=open`, but the stamped
    // base is the location the rewrite started from — so the destination is
    // unchanged as far as the guard is concerned.
    location = {
      pathname: '/session',
      search: { dir: '/home/user/old', settings: 'open' },
      state: { inPlaceBase: { pathname: '/session', search: { dir: '/home/user/old' } } },
    };
    answer({ sessions: [{ id: 'sess-1' } as Session] });

    return pending.then(() => {
      expect(store.setSelectedCwd).toHaveBeenCalledWith('/home/user/project');
      expect(navigate).toHaveBeenCalledWith({
        dir: '/home/user/project',
        session: 'sess-1',
      });
    });
  });

  it('navigates with a fresh session id when none is cached anywhere', async () => {
    const navigate = vi.fn();
    await switchAgentCwd('/home/user/project', {
      store: makeStore(),
      queryClient: new QueryClient(),
      transport: makeTransport(),
      currentLocation: () => ({ pathname: '/session', search: {} }),
      navigate,
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    const arg = navigate.mock.calls[0][0] as { dir: string; session: string };
    expect(arg.dir).toBe('/home/user/project');
    expect(arg.session).toMatch(UUID_RE);
  });
});

describe('executeUiCommand switch_agent → switchAgentCwd (wired path)', () => {
  it('dispatching switch_agent switches the cwd and navigates', async () => {
    // Compose the dispatcher with the exact wiring main.tsx installs: the
    // context's switchAgent delegates to switchAgentCwd. This proves the
    // control_ui switch_agent command now produces a real cwd switch rather
    // than the pre-DOR-354 no-op.
    const store = makeStore();
    const queryClient = new QueryClient();
    seedSession(queryClient, '/home/user/new', 'sess-new');
    const navigate = vi.fn();

    const ctx: DispatcherContext = {
      // switch_agent never reads the dispatcher store; a bare stub is honest here.
      getStore: () => ({}) as DispatcherStore,
      setTheme: vi.fn(),
      switchAgent: (cwd) =>
        void switchAgentCwd(cwd, {
          store,
          queryClient,
          transport: makeTransport(),
          currentLocation: () => ({ pathname: '/session', search: {} }),
          navigate,
        }),
    };

    executeUiCommand(ctx, { action: 'switch_agent', cwd: '/home/user/new' }, 'agent');
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());

    expect(store.setSelectedCwd).toHaveBeenCalledWith('/home/user/new');
    expect(navigate).toHaveBeenCalledWith({ dir: '/home/user/new', session: 'sess-new' });
  });
});
