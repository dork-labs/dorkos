/**
 * Shared setup for the canvas-service suites: everything the original file declared or
 * registered outside its tests.
 */
import { beforeEach } from 'vitest';
import type { RoomEntry, RoomEvent, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { UiCommand } from '@dorkos/shared/schemas';
import type { AuthorRegistry } from '../../rooms/author-registry.js';
import type { RoomService } from '../../rooms/room-service.js';
import type { RoomCanvasService } from '../../rooms/canvas/room-canvas-service.js';
import type { CanvasDocumentStore } from '../canvas-document-store.js';
import type { RoomBroadcaster } from '../../rooms/room-stream.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
} from '../../rooms/__tests__/room-test-harness.js';

/** What each test runs against; the hooks below reset it. */
export const st = {
  service: undefined as unknown as RoomService,
  canvas: undefined as unknown as RoomCanvasService,
  canvasDocuments: undefined as unknown as CanvasDocumentStore,
  broadcaster: undefined as unknown as RoomBroadcaster,
  authors: undefined as unknown as AuthorRegistry,
  room: undefined as unknown as RoomWithRoster,
  human: undefined as unknown as string,
  ana: undefined as unknown as string,
  ben: undefined as unknown as string,
};

export const ANA = '/agents/ana';

export const BEN = '/agents/ben';

export const agents = agentLookupFor({
  [ANA]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  [BEN]: { name: 'ben', displayName: 'Ben', responseMode: 'always' },
});

/** A document with no natural identity, so nothing dedupes a double write away. */
export const jsonContent = (label: string) =>
  ({ type: 'json', data: { label }, title: label }) as const;

/** Markdown whose text travels with its room row while its source tree is still recorded. */
export const markdownContent = (sourcePath: string) =>
  ({ type: 'markdown', content: `# ${sourcePath}`, sourcePath }) as const;

/**
 * Subscribe to a room's live stream, run `act`, and return what was fanned out.
 *
 * The real broadcaster rather than a spy on it: a `canvas` frame that never
 * reaches a subscriber is the failure this exists to catch, and a spy on
 * `publish` would report a success the stream never delivered.
 *
 * @param broadcaster - The room's live stream.
 * @param roomId - The room to listen to.
 * @param act - What to do while listening.
 * @returns Every frame delivered while `act` ran.
 */
export async function collectFrames(
  broadcaster: RoomBroadcaster,
  roomId: string,
  act: () => Promise<void>
): Promise<RoomEvent[]> {
  const abort = new AbortController();
  const seen: RoomEvent[] = [];
  const reading = (async () => {
    for await (const event of broadcaster.subscribe(roomId, abort.signal)) seen.push(event);
  })();
  await act();
  // One macrotask hop for the drain loop to deliver what is queued, then stop.
  await new Promise((resolve) => setTimeout(resolve, 0));
  abort.abort();
  await reading;
  return seen;
}

beforeEach(() => {
  ({
    service: st.service,
    authors: st.authors,
    human: st.human,
    canvasDocuments: st.canvasDocuments,
    broadcaster: st.broadcaster,
  } = createRoomHarness({
    agents,
    runner: scriptedRunner(() => null),
  }));
  st.canvas = st.service.canvas;
  st.room = st.service.createRoom(
    { kind: 'channel', title: 'Release train', members: [], agentPaths: [ANA, BEN] },
    st.human
  );
  st.ana = st.authors.resolveAgent(ANA, 'Ana').id;
  st.ben = st.authors.resolveAgent(BEN, 'Ben').id;
});

/** Ask the one writer, as a room turn does. */
export const applyAs = (authorId: string, turnId: string, command: UiCommand, cwd?: string) =>
  st.canvas.apply({
    roomId: st.room.id,
    authorId,
    turnId,
    command,
    ...(cwd !== undefined ? { cwd } : {}),
  });

/** Every entry in the room, oldest first. */
export const log = (): RoomEntry[] => st.service.listEntries(st.room.id, st.human, { limit: 200 });
