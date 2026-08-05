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
import { sessionKeys } from '../api/query-keys';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeStore(overrides: Partial<SwitchAgentCwdStore> = {}): SwitchAgentCwdStore {
  return {
    selectedCwd: null,
    setSelectedCwd: vi.fn(),
    setPreviousCwd: vi.fn(),
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
      navigate,
    });
    expect(store.setSelectedCwd).toHaveBeenCalledWith('/home/user/project');
  });

  it('records the current directory as the switch-back target when it differs', async () => {
    const store = makeStore({ selectedCwd: '/home/user/old' });
    await switchAgentCwd('/home/user/new', {
      store,
      queryClient: new QueryClient(),
      transport: makeTransport(),
      navigate: vi.fn(),
    });
    expect(store.setPreviousCwd).toHaveBeenCalledWith('/home/user/old');
  });

  it('does not record a switch-back target when already in the directory', async () => {
    const store = makeStore({ selectedCwd: '/home/user/same' });
    await switchAgentCwd('/home/user/same', {
      store,
      queryClient: new QueryClient(),
      transport: makeTransport(),
      navigate: vi.fn(),
    });
    expect(store.setPreviousCwd).not.toHaveBeenCalled();
  });

  it('does not record a switch-back target when no directory is active', async () => {
    const store = makeStore({ selectedCwd: null });
    await switchAgentCwd('/home/user/project', {
      store,
      queryClient: new QueryClient(),
      transport: makeTransport(),
      navigate: vi.fn(),
    });
    expect(store.setPreviousCwd).not.toHaveBeenCalled();
  });

  it('navigates reusing the most-recent cached session for the directory', async () => {
    const queryClient = new QueryClient();
    seedSession(queryClient, '/home/user/project', 'sess-cached');
    const navigate = vi.fn();
    await switchAgentCwd('/home/user/project', {
      store: makeStore(),
      queryClient,
      transport: makeTransport(),
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
      navigate,
    });
    expect(navigate).toHaveBeenCalledWith({
      dir: '/home/user/project',
      session: 'sess-on-server',
    });
  });

  it('navigates with a fresh session id when none is cached anywhere', async () => {
    const navigate = vi.fn();
    await switchAgentCwd('/home/user/project', {
      store: makeStore(),
      queryClient: new QueryClient(),
      transport: makeTransport(),
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
    const store = makeStore({ selectedCwd: '/home/user/old' });
    const queryClient = new QueryClient();
    seedSession(queryClient, '/home/user/new', 'sess-new');
    const navigate = vi.fn();

    const ctx: DispatcherContext = {
      // switch_agent never reads the dispatcher store; a bare stub is honest here.
      getStore: () => ({}) as DispatcherStore,
      setTheme: vi.fn(),
      switchAgent: (cwd) =>
        void switchAgentCwd(cwd, { store, queryClient, transport: makeTransport(), navigate }),
    };

    executeUiCommand(ctx, { action: 'switch_agent', cwd: '/home/user/new' }, 'agent');
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());

    expect(store.setPreviousCwd).toHaveBeenCalledWith('/home/user/old');
    expect(store.setSelectedCwd).toHaveBeenCalledWith('/home/user/new');
    expect(navigate).toHaveBeenCalledWith({ dir: '/home/user/new', session: 'sess-new' });
  });
});
