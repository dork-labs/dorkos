/**
 * `api.rooms` in the browser (DOR-3017): one mini app reads and replies in room
 * threads as the person signed in.
 *
 * Every URL carries THIS mini app's id, and the server scopes each route to it
 * and to the rooms the person picked for it. The writes send the app window's
 * `X-Client-Id`, which the server's room-write bar requires beside a trusted
 * `Origin` the browser adds itself.
 *
 * @module features/extensions/model/extension-rooms-api
 */
import {
  RoomAccessError,
  type ExtensionRoomsApi,
  type RoomAccessErrorCode,
  type RoomRef,
  type RoomThread,
  type RoomThreadEntry,
} from '@dorkos/extension-api';
import { resolveStableClientId } from '@/layers/shared/lib/transport';
import { extensionApiUrl } from './extension-api-url';

/** The codes the server answers with that `api.rooms` throws as themselves. */
const ROOM_ACCESS_CODES: ReadonlySet<string> = new Set<RoomAccessErrorCode>([
  'room_not_allowed',
  'not_found',
  'person_required',
  'extension_off',
  'invalid_input',
  'unavailable',
]);

/** A refused response, as a {@link RoomAccessError}. */
async function refusal(res: Response): Promise<RoomAccessError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  const code: RoomAccessErrorCode =
    body.code && ROOM_ACCESS_CODES.has(body.code)
      ? (body.code as RoomAccessErrorCode)
      : res.status === 404
        ? 'not_found'
        : res.status === 403
          ? 'person_required'
          : 'unavailable';
  return new RoomAccessError(code, body.error ?? 'DorkOS could not do that. Try again.');
}

/**
 * Build one mini app's `api.rooms`.
 *
 * @param extId - The mini app's id.
 * @param cleanups - Where to put each stream's close, so deactivating the mini
 *   app closes every thread it was listening to.
 */
export function createExtensionRoomsApi(
  extId: string,
  cleanups: Array<() => void>
): ExtensionRoomsApi {
  const roomsUrl = (path: string) =>
    extensionApiUrl(`/extensions/${encodeURIComponent(extId)}/rooms${path}`);
  const threadPath = (roomId: string, rootEntryId: string) =>
    `/${encodeURIComponent(roomId)}/threads/${encodeURIComponent(rootEntryId)}`;

  /** Fetch, throwing a {@link RoomAccessError} on refusal or a network failure. */
  const call = async (url: string, init?: RequestInit): Promise<Response> => {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch {
      throw new RoomAccessError('unavailable', 'DorkOS could not be reached. Try again.');
    }
    if (!res.ok) throw await refusal(res);
    return res;
  };

  /** The headers a write needs: the window's client id, and JSON when there is a body. */
  const writeHeaders = (json: boolean): HeadersInit => ({
    'X-Client-Id': resolveStableClientId(),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  });

  return {
    async listRooms(): Promise<RoomRef[]> {
      const res = await call(roomsUrl(''));
      return ((await res.json()) as { rooms: RoomRef[] }).rooms;
    },

    async readThread(roomId: string, rootEntryId: string): Promise<RoomThread> {
      const res = await call(roomsUrl(threadPath(roomId, rootEntryId)));
      return (await res.json()) as RoomThread;
    },

    async reply(roomId: string, rootEntryId: string, text: string): Promise<RoomThreadEntry> {
      const res = await call(roomsUrl(`${threadPath(roomId, rootEntryId)}/replies`), {
        method: 'POST',
        headers: writeHeaders(true),
        body: JSON.stringify({ text }),
      });
      return (await res.json()) as RoomThreadEntry;
    },

    async unreadCounts(
      roomId: string,
      rootEntryIds: readonly string[]
    ): Promise<Record<string, number>> {
      if (rootEntryIds.length === 0) return {};
      const query = new URLSearchParams({ threads: rootEntryIds.join(',') });
      const res = await call(roomsUrl(`/${encodeURIComponent(roomId)}/unread?${query}`));
      return ((await res.json()) as { counts: Record<string, number> }).counts;
    },

    async markRead(roomId: string, rootEntryId: string): Promise<void> {
      await call(roomsUrl(`${threadPath(roomId, rootEntryId)}/read`), {
        method: 'PUT',
        headers: writeHeaders(false),
      });
    },

    subscribeThread(
      roomId: string,
      rootEntryId: string,
      listener: (entry: RoomThreadEntry) => void
    ): () => void {
      // EventSource reconnects by itself and resends the last reply's id, so
      // replies written while the connection was down arrive once it is back.
      const source = new EventSource(roomsUrl(`${threadPath(roomId, rootEntryId)}/events`));
      source.addEventListener('reply', (event) => {
        try {
          listener(JSON.parse((event as MessageEvent<string>).data) as RoomThreadEntry);
        } catch (err) {
          console.error(`[extensions] ${extId}: a thread listener threw`, err);
        }
      });
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        source.close();
        const at = cleanups.indexOf(close);
        if (at !== -1) cleanups.splice(at, 1);
      };
      cleanups.push(close);
      return close;
    },
  };
}
