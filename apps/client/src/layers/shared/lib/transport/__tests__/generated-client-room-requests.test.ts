/**
 * The room calls that moved onto the generated API client (DOR-5473) send
 * exactly the requests their hand-written calls did: method, URL and body (each
 * key below), JSON typing and the cookie. The bodyless writes still send no body.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoomMethods } from '../room-methods';
import { answer } from './request-stub';

afterEach(() => vi.unstubAllGlobals());

const rooms = createRoomMethods('/api');
const commit = 'abc1234';

const sent: Record<string, () => Promise<unknown>> = {
  // Rooms and their settings. These routes sent the room id raw; the generated
  // client escapes it now. Room ids are ULIDs, so the bytes match in practice.
  'GET /api/rooms': () => rooms.listRooms(),
  'GET /api/rooms?kind=dm&includeArchived=false': () =>
    rooms.listRooms({ kind: 'dm', includeArchived: false }),
  'GET /api/rooms/threads?limit=5': () => rooms.listThreads({ limit: 5 }),
  'POST /api/rooms {"kind":"channel","title":"Ops","members":["a1"],"agentPaths":[]}': () =>
    rooms.createRoom({ kind: 'channel', title: 'Ops', members: ['a1'], agentPaths: [] }),
  'GET /api/rooms/r1': () => rooms.getRoom('r1'),
  // The change on record: an id that needs escaping is escaped now, where it went out raw.
  'GET /api/rooms/a%2Fb': () => rooms.getRoom('a/b'),
  'PATCH /api/rooms/r1 {"topic":null,"archived":true}': () =>
    rooms.updateRoom('r1', { topic: null, archived: true }),
  'GET /api/rooms/r1/entries?before=9&limit=20': () =>
    rooms.listRoomEntries('r1', { before: 9, limit: 20 }),
  'GET /api/rooms/r1/sessions': () => rooms.listRoomSessions('r1'),
  // Posting, threads and reactions.
  'POST /api/rooms/r1/entries {"text":"ship it"}': () =>
    rooms.postToRoom('r1', { text: 'ship it' }),
  'POST /api/rooms/r1/threads {"rootEntryId":"e1","text":"yes"}': () =>
    rooms.replyInThread('r1', { rootEntryId: 'e1', text: 'yes' }),
  'POST /api/rooms/r1/entries/e%2F1/reactions {"emoji":"👍"}': () =>
    rooms.toggleReaction('r1', 'e/1', { emoji: '👍' }),
  // Stopping turns, holds and seats.
  'POST /api/rooms/r1/halt': () => rooms.haltRoom('r1'),
  'POST /api/rooms/r1/halt/a%2F1': () => rooms.haltRoomAgent('r1', 'a/1'),
  'POST /api/rooms/r1/holds/a%2F1/promote': () => rooms.promoteHold('r1', 'a/1'),
  'GET /api/rooms/r1/members/a%2F1/reseat-options': () => rooms.getRoomReseatOptions('r1', 'a/1'),
  'POST /api/rooms/r1/members/a%2F1/reseat {"account":"two"}': () =>
    rooms.reseatRoomAgent('r1', 'a/1', { account: 'two' }),
  // The roster and author handles.
  'POST /api/rooms/r1/members {"authorId":"a1"}': () =>
    rooms.addRoomMember('r1', { authorId: 'a1' }),
  'PATCH /api/rooms/r1/members/a%2F1 {"responseMode":"silent"}': () =>
    rooms.updateRoomMember('r1', 'a/1', { responseMode: 'silent' }),
  'DELETE /api/rooms/r1/members/a%2F1': () => rooms.removeRoomMember('r1', 'a/1'),
  'PATCH /api/rooms/authors/a%2F1/handle {"handle":"sam"}': () =>
    rooms.setAuthorHandle('a/1', 'sam'),
  // Direct chats.
  'POST /api/direct-chats {"agentPath":"/agents/a"}': () =>
    rooms.openDirectChat({ agentPath: '/agents/a' }),
  'GET /api/direct-chats/by-session/s%2F1': () => rooms.findDirectChat('s/1'),
  // The room's files and repo, whose room ids were always escaped.
  'POST /api/rooms/a%2Fb/repo': () => rooms.enableRoomRepo('a/b'),
  'GET /api/rooms/a%2Fb/repo/status': () => rooms.readRoomRepoStatus('a/b'),
  // Keeping takes no list; discarding names exactly the files it destroys.
  'POST /api/rooms/a%2Fb/repo/main/repair {"action":"commit"}': () =>
    rooms.repairRoomMain('a/b', { action: 'commit' }),
  'POST /api/rooms/a%2Fb/repo/main/repair {"action":"discard","paths":["ROOM.md"]}': () =>
    rooms.repairRoomMain('a/b', { action: 'discard', paths: ['ROOM.md'] }),
  'POST /api/rooms/a%2Fb/repo/merge {"summary":"Done","worktree":"w1"}': () =>
    rooms.mergeRoomMain('a/b', { summary: 'Done', worktree: 'w1' }),
  'GET /api/rooms/a%2Fb/files': () => rooms.readRoomFiles('a/b'),
  'GET /api/rooms/a%2Fb/files?path=docs%2Fa+b': () => rooms.readRoomFiles('a/b', 'docs/a b'),
  'GET /api/rooms/a%2Fb/files/content?path=docs%2Fplan.md': () =>
    rooms.readRoomFileContent('a/b', 'docs/plan.md'),
  'PUT /api/rooms/a%2Fb/files/content {"path":"p.md","baseCommit":"abc1234","text":"x"}': () =>
    rooms.saveRoomFile('a/b', { path: 'p.md', baseCommit: commit, text: 'x' }),
  'PATCH /api/rooms/a%2Fb/files {"from":"a","to":"b","baseCommit":"abc1234"}': () =>
    rooms.moveRoomFile('a/b', { from: 'a', to: 'b', baseCommit: commit }),
  'DELETE /api/rooms/a%2Fb/files?path=docs%2Fa&baseCommit=abc1234': () =>
    rooms.deleteRoomFile('a/b', { path: 'docs/a', baseCommit: commit }),
  'POST /api/rooms/a%2Fb/files/from-attachment {"attachmentId":"t1","dir":"","baseCommit":null}':
    () => rooms.saveAttachmentToRoomFiles('a/b', { attachmentId: 't1', dir: '', baseCommit: null }),
  // The room's shared canvas and following.
  'DELETE /api/rooms/a%2Fb/canvas/d%2F1': () => rooms.closeRoomCanvasDocument('a/b', 'd/1'),
  'GET /api/rooms/a%2Fb/canvas/d%2F1/diff': () => rooms.readRoomCanvasDiff('a/b', 'd/1'),
  'PUT /api/rooms/a%2Fb/canvas/d%2F1/diff {"content":"x","expectedHash":"h1"}': () =>
    rooms.writeRoomCanvasDiff('a/b', 'd/1', { content: 'x', expectedHash: 'h1' }),
  'POST /api/rooms/a%2Fb/canvas/viewing {"documentId":null}': () =>
    rooms.setRoomCanvasViewing('a/b', null),
  'POST /api/rooms/a%2Fb/canvas/d%2F1/editing {"editing":false}': () =>
    rooms.setRoomCanvasEditing('a/b', 'd/1', false),
  'POST /api/rooms/a%2Fb/canvas/d%2F1/thread': () => rooms.discussCanvasDocument('a/b', 'd/1'),
  'PUT /api/rooms/a%2Fb/follow {"memberId":"m1"}': () => rooms.followRoomMember('a/b', 'm1'),
  'DELETE /api/rooms/a%2Fb/follow': () => rooms.unfollowRoomMember('a/b'),
  'POST /api/rooms/a%2Fb/follow/view {"documentId":"d1","scrollY":40}': () =>
    rooms.publishRoomView('a/b', { documentId: 'd1', scrollY: 40 }),
};

describe('room calls on the generated client', () => {
  it.each(Object.entries(sent))('%s', async (request, call) => {
    const fetchMock = answer({});
    // `{}` may not parse as the method's answer; only the request matters here.
    await call().catch(() => undefined);
    const [url, init] = fetchMock.mock.calls[0]!;
    const body = init?.body === undefined ? '' : ` ${String(init.body)}`;
    expect(`${init?.method ?? 'GET'} ${String(url)}${body}`).toBe(request);
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(init?.credentials).toBe('include');
  });

  it('reads a missing or forbidden Direct chat as none', async () => {
    for (const status of [404, 403]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('{}', { status }))
      );
      await expect(rooms.findDirectChat('s1')).resolves.toBeNull();
    }
  });
});
