/**
 * A room the sheet can actually read, with no server behind it.
 *
 * The room sheet is the one component on this page with no prop seam: it reads
 * five queries and owns four mutations, all through the `Transport` port. The
 * playground's default transport resolves every call with `null`, which lands
 * the sheet on exactly one of its states — a room that is not there — and
 * leaves the other six unreachable, which is the gap `/dev/rooms` exists to
 * close.
 *
 * So the seam used here is the port itself, the way `RefusedConfigWriteProvider`
 * fakes a refused config write: a transport that answers the five reads from a
 * fixture and applies the four writes to it. The component under review is the
 * real one, unmodified, running its real hooks — the only thing replaced is the
 * machine at the other end of the wire.
 *
 * **The fixture is mutable on purpose.** A read-only one would show every
 * state and let a reviewer test none of them: every write in this sheet
 * invalidates and re-reads, so a frozen fixture answers each change by putting
 * it straight back. Holding the room in a closure means a rung sticks, a
 * removed agent leaves the roster with its own animation, and the Undo toast —
 * which only exists on a removal the server agreed to — is reachable at all.
 *
 * @module dev/showcases/rooms-showcase-helpers
 */
import { useEffect, useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { RoomRosterEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { PanelErrorBoundary } from '@/layers/features/right-panel';
import {
  RoomPanelBody,
  useRoomPanelFocusStore,
  type RoomDetailsFocus,
} from '@/layers/features/room-management';
import { createPlaygroundTransport } from '../playground-transport';
import { createAgentAuthor, createRoomMember } from '../mock-factories';
import { ROOM_FLEET, ROOMS_SERVER_CONFIG } from './rooms-showcase-data';

/** One agent in the fleet a fixture offers, manifest or not. */
export interface FleetEntry {
  agentPath: string;
  manifest: AgentManifest | null;
}

/**
 * What the room read answers with: a room, or a read that never lands, or one
 * that fails.
 *
 * The two failure shapes are strings rather than flags because they are
 * mutually exclusive with having a room and with each other, and a fixture
 * carrying `{ room, isLoading, isError }` could be asked for two of them.
 */
export type RoomRead = RoomWithRoster | 'loading' | 'error';

/** Build the author row the server would mint for an agent joining a room. */
function authorForAgent(entry: FleetEntry): ReturnType<typeof createAgentAuthor> {
  const manifest = entry.manifest;
  return createAgentAuthor(entry.agentPath, {
    id: `author-${entry.agentPath.split('/').pop()}`,
    displayName:
      manifest?.displayName ?? manifest?.name ?? entry.agentPath.split('/').pop() ?? 'agent',
    ...(manifest?.icon === undefined ? {} : { emoji: manifest.icon }),
    ...(manifest?.color === undefined ? {} : { color: manifest.color }),
  });
}

/**
 * A transport backed by one room held in memory.
 *
 * Only the calls this sheet makes are answered; everything else falls through
 * to the playground's own transport, which resolves `null`. A `Proxy` rather
 * than a spread, for the reason `RefusedConfigWriteProvider` gives: the base is
 * itself a Proxy over an empty target, so spreading it copies nothing.
 *
 * @param read - What `getRoom` answers with, and the room writes then edit.
 * @param fleet - The agents the picker may offer.
 */
function createRoomFixtureTransport(read: RoomRead, fleet: FleetEntry[]): Transport {
  let room = typeof read === 'string' ? null : structuredClone(read);
  const base = createPlaygroundTransport();

  /** The room as it now stands, cloned so a reader cannot mutate the fixture. */
  const snapshot = (): Promise<RoomWithRoster> => {
    if (read === 'loading') return new Promise<RoomWithRoster>(() => {});
    if (read === 'error' || room === null) {
      return Promise.reject(new Error('Reading that room failed'));
    }
    return Promise.resolve(structuredClone(room));
  };

  const handlers: Partial<Record<keyof Transport, unknown>> = {
    getRoom: snapshot,
    listRoomEntries: () => Promise.resolve([]),
    getConfig: () => Promise.resolve(ROOMS_SERVER_CONFIG),
    listMeshAgentPaths: () =>
      Promise.resolve({
        agents: fleet.map((entry) => ({
          id: entry.manifest?.id ?? entry.agentPath,
          name: entry.manifest?.name ?? entry.agentPath.split('/').pop() ?? 'agent',
          projectPath: entry.agentPath,
        })),
      }),
    resolveAgents: (paths: string[]) =>
      Promise.resolve(
        Object.fromEntries(
          paths.map((path) => [path, fleet.find((e) => e.agentPath === path)?.manifest ?? null])
        )
      ),
    addRoomMember: (_roomId: string, req: { agentPath: string; responseMode?: string }) => {
      const entry = fleet.find((candidate) => candidate.agentPath === req.agentPath);
      if (room === null || entry === undefined) {
        return Promise.reject(new Error('No such agent'));
      }
      const member = createRoomMember({
        roomId: room.id,
        author: authorForAgent(entry),
        // The server seeds a channel join at `engaged` unless the caller names
        // a mode — which the undo does, and which is the whole point of it.
        responseMode: (req.responseMode as RoomRosterEntry['responseMode']) ?? 'engaged',
        joinedAt: new Date().toISOString(),
      });
      room = { ...room, members: [...room.members, member] };
      return Promise.resolve(member);
    },
    removeRoomMember: (_roomId: string, authorId: string) => {
      if (room !== null) {
        room = { ...room, members: room.members.filter((m) => m.authorId !== authorId) };
      }
      return Promise.resolve(undefined);
    },
    updateRoomMember: (
      _roomId: string,
      authorId: string,
      req: { responseMode: RoomRosterEntry['responseMode'] }
    ) => {
      const member = room?.members.find((m) => m.authorId === authorId);
      if (room === null || member === undefined) return Promise.reject(new Error('Not a member'));
      const updated = { ...member, responseMode: req.responseMode };
      room = { ...room, members: room.members.map((m) => (m === member ? updated : m)) };
      return Promise.resolve(updated);
    },
    updateRoom: (_roomId: string, patch: Partial<RoomWithRoster>) => {
      if (room === null) return Promise.reject(new Error('No room'));
      room = { ...room, ...patch };
      return Promise.resolve(structuredClone(room));
    },
  };

  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in handlers) return handlers[prop as keyof Transport];
      return Reflect.get(target, prop, receiver);
    },
  });
}

export interface RoomPanelDemoProps {
  /** What this showcase is showing, printed above the panel. */
  label: string;
  /** What the room read answers with, and what the writes then edit. */
  read: RoomRead;
  /**
   * The room this panel is about.
   *
   * Only its id reaches the panel. Everything drawn comes from the read, the
   * way it does on a real route — which is why the loading and failing fixtures
   * show a skeleton and a retry rather than a name.
   */
  holds: RoomWithRoster;
  /** The agents the picker may offer. The whole cast unless told otherwise. */
  fleet?: FleetEntry[];
  /** Which door opened it — `'add'` opens the picker already open. */
  focus?: RoomDetailsFocus;
}

/**
 * One room panel, in a box the size of the right panel, against a fixture that
 * behaves like a server.
 *
 * Rendered open and side by side rather than behind a trigger: this stopped
 * being a modal in phase R2, so several of them no longer stack overlays over
 * the page — they are panels a reviewer can compare at a glance, which is what
 * a showcase page is for.
 *
 * Mounted inside the same `PanelErrorBoundary` the right-panel container wraps
 * every tab in, so what is on review is the panel as it actually ships.
 *
 * Each demo gets its own `QueryClient` and its own fixture, so a rung changed
 * in one showcase is not visible in the next.
 */
export function RoomPanelDemo({
  label,
  read,
  holds,
  fleet = ROOM_FLEET,
  focus,
}: RoomPanelDemoProps) {
  // Built once per mount: a fresh transport would forget every write, and a
  // fresh client would refetch into one that had.
  const transport = useMemo(() => createRoomFixtureTransport(read, fleet), [read, fleet]);
  const client = useMemo(
    () =>
      new QueryClient({
        // `retry: false` is what makes the failing fixture reach `isError`
        // within the frame rather than after three backoffs.
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
    []
  );

  // The press an entry point would have made, as the panel receives it. Named
  // for this fixture's room, so only this demo answers it — the store is one
  // module shared by every panel on the page.
  useEffect(() => {
    if (focus === undefined) return;
    useRoomPanelFocusStore.setState({ request: { focus, roomId: holds.id, nonce: Date.now() } });
  }, [focus, holds.id]);

  return (
    <TransportProvider transport={transport}>
      <QueryClientProvider client={client}>
        <div className="flex w-[22rem] shrink-0 flex-col gap-2">
          <p className="text-muted-foreground text-xs">{label}</p>
          {/* The right panel's own frame: a bordered column on the sidebar's
              ground, bounded in height so the roster scrolls inside it rather
              than running down the showcase page. */}
          <div className="bg-sidebar text-sidebar-foreground h-[30rem] overflow-hidden rounded-lg border">
            <PanelErrorBoundary tabId="room">
              <RoomPanelBody roomId={holds.id} />
            </PanelErrorBoundary>
          </div>
        </div>
      </QueryClientProvider>
    </TransportProvider>
  );
}
