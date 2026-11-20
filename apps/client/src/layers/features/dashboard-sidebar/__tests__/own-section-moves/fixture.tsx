import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { vi, expect } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { SidebarPrefsSchema, USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { AgentManifestSchema } from '@dorkos/shared/mesh-schemas';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { EventStreamProvider, TransportProvider } from '@/layers/shared/model';
import { SidebarProvider, TooltipProvider } from '@/layers/shared/ui';
import { configKeys, moveToGroup, useUpdateSidebarPrefs } from '@/layers/entities/config';
import type { ServerConfig } from '@dorkos/shared/types';
import { DashboardSidebar } from '../../ui/DashboardSidebar';

export const AGENT_PATH = '/fixture/agent';
export const CHANNEL: RoomSummary = {
  id: 'fixture-channel',
  kind: 'channel',
  slug: 'fixture-channel',
  title: 'Fixture channel',
  topic: null,
  archived: false,
  ambientMaxEntries: 30,
  createdAt: '2026-11-16T00:00:00.000Z',
  lastActivityAt: '2026-11-16T00:00:00.000Z',
  unreadCount: 0,
  participants: null,
};
/** A genuine second listed room keeps the live Channels section present after the own move. */
export const COMPANION: RoomSummary = {
  ...CHANNEL,
  id: 'fixture-companion',
  slug: 'companion',
  title: 'Companion channel',
};
const PREFS = SidebarPrefsSchema.parse({
  pinned: [{ kind: 'agent', path: AGENT_PATH }],
  pinnedApps: [],
  groups: [
    { id: 'chosen', name: 'Chosen', items: [] },
    {
      id: 'codex',
      name: 'Codex agents',
      kind: 'smart',
      sortMode: 'name',
      rules: { runtimes: ['codex'] },
      items: [],
    },
  ],
});

/** A rendezvous, rather than a sleep standing in for a completed operation. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Browser stream edge: accepts subscriptions without opening a network connection. */
export class FixtureSocket extends EventTarget {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  send() {}
  close() {
    this.readyState = FixtureSocket.CLOSED;
  }
}

/** Use the same public update hook and mutator as the sidebar's own accepted move. */
function MoveChannel() {
  const { updateAsync } = useUpdateSidebarPrefs();
  return (
    <button
      onClick={() =>
        void updateAsync((prev) =>
          moveToGroup(prev, { kind: 'room', roomId: CHANNEL.id }, 'chosen')
        )
      }
    >
      Move fixture channel
    </button>
  );
}

/** Mount the real parent, state/model hooks, child renderer and Query observers. */
export async function mountSidebar() {
  let unmountOwned: (() => void) | null = null;
  let clearOwned: (() => void) | null = null;
  const releaseOwned = () => {
    const failures: unknown[] = [];
    for (const action of [unmountOwned, clearOwned]) {
      if (action === null) continue;
      try {
        action();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'owned fixture cleanup failed');
  };
  try {
    const writeStarted = deferred();
    const writeReply = deferred();
    const base = createMockTransport();
    let serverConfig = {
      ...(await base.getConfig()),
      ui: { ...USER_CONFIG_DEFAULTS.ui, sidebar: PREFS },
      agents: USER_CONFIG_DEFAULTS.agents,
    };
    let manifest = AgentManifestSchema.parse({
      id: '01HZ0000000000000000000001',
      name: 'Fixture agent',
      description: 'Fixture',
      runtime: 'codex',
      registeredAt: '2026-11-16T00:00:00.000Z',
      registeredBy: 'fixture',
    });
    const transport = createMockTransport({
      getConfig: vi.fn(async () => structuredClone(serverConfig)),
      updateConfig: vi.fn(async (patch) => {
        serverConfig = { ...serverConfig, ui: { ...serverConfig.ui, ...patch.ui } };
        writeStarted.resolve();
        await writeReply.promise;
      }),
      listRooms: vi.fn(async () => [CHANNEL, COMPANION]),
      listMeshAgentPaths: vi.fn(async () => ({
        agents: [{ id: manifest.id, name: manifest.name, projectPath: AGENT_PATH }],
      })),
      resolveAgents: vi.fn(async () => ({ [AGENT_PATH]: manifest })),
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    clearOwned = () => client.clear();
    const root = createRootRoute({
      staticData: { header: null },
      component: () => (
        <>
          <MoveChannel />
          <DashboardSidebar />
        </>
      ),
    });
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    const view = render(
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport}>
          <EventStreamProvider>
            <TooltipProvider>
              <SidebarProvider>
                <RouterProvider router={router} />
              </SidebarProvider>
            </TooltipProvider>
          </EventStreamProvider>
        </TransportProvider>
      </QueryClientProvider>
    );
    unmountOwned = () => view.unmount();
    await screen.findByText('fixture-channel');
    await screen.findByText('companion');
    await screen.findByRole('button', { name: 'Chosen' });
    await screen.findByText('Fixture agent');
    const section = (id: string) => {
      const matches = view.container.querySelectorAll<HTMLElement>(
        `[data-sidebar-section="${id}"]`
      );
      expect(matches).toHaveLength(1);
      return matches[0]!;
    };
    const channel = () => {
      const rows = within(section('channels')).getAllByText('fixture-channel');
      expect(rows).toHaveLength(1);
      return rows[0]!.closest<HTMLElement>('[data-sidebar-row]')!;
    };
    let unsubscribeFocus = () => {};
    let focusInjected = false;
    let focusDispatches = 0;
    let focusRetained = false;
    const nativeClick = () => screen.getByRole('button', { name: 'Move fixture channel' }).click();
    return {
      client,
      transport,
      section,
      channel,
      channelCopies() {
        return Array.from(
          view.container.querySelectorAll('[data-sidebar-section="channels"] [data-sidebar-row]')
        ).filter((row) => row.textContent?.includes('fixture-channel')).length;
      },
      persisted: () => serverConfig.ui.sidebar,
      optimisticItems() {
        expect(
          client.getQueryCache().findAll({ queryKey: configKeys.current(), exact: true })
        ).toHaveLength(1);
        return client
          .getQueryData<ServerConfig>(configKeys.current())
          ?.ui?.sidebar?.groups.find((group) => group.id === 'chosen')?.items;
      },
      nativeClick,
      armFocus() {
        const source = channel();
        unsubscribeFocus = client.getQueryCache().subscribe((event) => {
          if (event.type !== 'updated' || event.action.type !== 'success' || focusInjected) return;
          if (JSON.stringify(event.query.queryKey) !== JSON.stringify(configKeys.current())) return;
          const value = event.query.state.data as ServerConfig | undefined;
          if (
            !value?.ui?.sidebar.groups.some(
              (g) =>
                g.id === 'chosen' &&
                g.items.some((i) => i.kind === 'room' && i.roomId === CHANNEL.id)
            )
          )
            return;
          focusInjected = true;
          queueMicrotask(() => {
            focusDispatches++;
            source.focus();
            focusRetained = document.activeElement === source;
          });
        });
      },
      focusTrigger() {
        return { dispatches: focusDispatches, retained: focusRetained };
      },
      enter() {
        fireEvent.pointerOver(channel());
      },
      focusInside() {
        const row = channel();
        act(() => row.focus());
        expect(document.activeElement).toBe(row);
      },
      leave() {
        const focused = document.activeElement!;
        act(() => screen.getByRole('button', { name: 'Move fixture channel' }).focus());
        fireEvent.pointerOut(focused, { relatedTarget: document.body });
      },
      async startOwnMove() {
        fireEvent.click(screen.getByRole('button', { name: 'Move fixture channel' }));
        await act(async () => {
          await writeStarted.promise;
        });
        expect(transport.updateConfig).toHaveBeenCalledTimes(1);
        expect(
          serverConfig.ui.sidebar.groups.find((group) => group.id === 'chosen')?.items
        ).toEqual([{ kind: 'room', roomId: CHANNEL.id }]);
      },
      async accept() {
        await act(async () => writeReply.resolve());
      },
      async changeAgent() {
        manifest = { ...manifest, name: 'Updated fixture agent', runtime: 'claude-code' };
        await act(async () => {
          await client.invalidateQueries({ queryKey: ['agents', 'resolved'] });
        });
      },
      dispose() {
        unsubscribeFocus();
        releaseOwned();
      },
    };
  } catch (originalError) {
    try {
      releaseOwned();
    } catch (cleanupError) {
      // Cleanup trouble is visible, but never replaces the original setup failure.
      console.error('SIDEBAR_FIXTURE_CLEANUP_FAILURE', cleanupError);
    }
    throw originalError;
  }
}
