/**
 * Messages join the notification pipeline — `dm.received` and
 * `mention.received` (spec `notification-system` task T11, DOR-1388).
 *
 * The real `RoomService` runs throughout (`createRoomHarness`, in-memory
 * `better-sqlite3`), wired to a real `NotificationService`/`NotificationStore`
 * over the SAME database — the claim under test is that one committed entry
 * produces the right row (or none) in the OTHER domain's table, which a mocked
 * notification service could not prove.
 *
 * @module server/services/rooms/__tests__/room-message-notifications
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eventFanOut } from '../../core/event-fan-out.js';
import { NotificationStore } from '../../notifications/notification-store.js';
import {
  NotificationService,
  setNotificationService,
} from '../../notifications/notification-service.js';
import type { CreateBridgedRoomRequest } from '../room-service.js';
import { agentLookupFor, createRoomHarness, type RoomHarness } from './room-test-harness.js';

const agentLookup = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana' },
  '/agents/bo': { name: 'bo', displayName: 'Bo' },
});

/** One captured global-stream broadcast. */
type Broadcast = [string, unknown];

let sent: Broadcast[] = [];
let notifications: NotificationService;

/** Let the fire-and-forget `notify()` microtasks settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

/** Every stored notification, newest first — the same read every surface uses. */
function stored() {
  return notifications.list({ limit: 25, unread: false }).notifications;
}

/** Every `notification` SSE frame announced so far, of one kind. */
function announced(kind: 'dm.received' | 'mention.received') {
  return sent
    .filter(([name]) => name === 'notification')
    .map(([, data]) => (data as { notification: { kind: string } }).notification)
    .filter((n) => n.kind === kind);
}

/** Wire a fresh rooms subsystem AND a fresh notification pipeline over one database. */
function open(opts: { isRoomMuted?: (roomId: string) => boolean } = {}): RoomHarness {
  const harness = createRoomHarness({ agents: agentLookup, ...opts });
  notifications = new NotificationService(new NotificationStore(harness.db));
  setNotificationService(notifications);
  return harness;
}

beforeEach(() => {
  sent = [];
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation((name, data) => {
    sent.push([name, data]);
  });
});

afterEach(() => {
  setNotificationService(null);
  vi.restoreAllMocks();
});

describe('an agent DM to the operator', () => {
  it('raises dm.received, addressed and carrying the room', async () => {
    const harness = open();
    const room = harness.service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      harness.human
    );
    const ana = harness.authors.resolveAgent('/agents/ana', 'Ana').id;

    harness.service.post(room.id, { authorId: ana, text: 'the deploy is green' });
    await flush();

    expect(announced('dm.received')).toHaveLength(1);
    const [row] = stored();
    expect(row).toMatchObject({
      kind: 'dm.received',
      title: 'Ana messaged you',
      body: 'the deploy is green',
      roomId: room.id,
    });
    expect(row.readAt).toBeUndefined();
  });

  it('never fires for the operator posting their own message', async () => {
    const harness = open();
    const room = harness.service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      harness.human
    );

    harness.service.post(room.id, { authorId: harness.human, text: 'hey ana' });
    await flush();

    expect(stored()).toHaveLength(0);
  });

  it('never fires dm.received for a human posting in a bridged DM, mention or not', async () => {
    // dm.received is agent-only (`isDirectMessage` requires `author.kind ===
    // 'agent'`), so a human posting in a `dm`-kind room never raises it —
    // whether that human is the operator's own bridged phone leg or a real
    // collaborator (see the paired test below for the mention half of that
    // second case).
    const harness = open();
    const bridged = harness.service.createBridgedRoom(bridgeDm(harness));
    expect(bridged.kind).toBe('dm');

    harness.service.postExternal(bridged.id, {
      identity: {
        platformType: 'telegram',
        instanceId: 'tg-main',
        platformUserId: '900900',
        displayName: 'Dorian',
      },
      text: 'on my way, be there in 10',
    });
    await flush();

    expect(stored()).toHaveLength(0);
  });

  it('raises no row for an agent DMing itself with nobody else on the roster', async () => {
    // The other edge `isOneOnOneDmWithOperator` guards: one agent, zero
    // humans, is a scratch room ("Ana notes", `three-way-rule.test.ts`), not
    // a DM with the operator — there is nobody there to notify.
    const harness = open();
    const ana = harness.authors.resolveAgent('/agents/ana', 'Ana').id;
    const room = harness.service.createRoom(
      { kind: 'dm', title: 'Ana notes', members: [], agentPaths: [] },
      ana
    );
    expect(room.members).toHaveLength(1); // ana alone; the owner was never seeded in

    harness.service.post(room.id, { authorId: ana, text: 'reminder to self' });
    await flush();

    expect(stored()).toHaveLength(0);
  });

  it('raises dm.received only, never a second mention.received, when the DM also names the operator', async () => {
    const harness = open();
    harness.authors.setHandle(harness.human, 'dorian');
    const room = harness.service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      harness.human
    );
    const ana = harness.authors.resolveAgent('/agents/ana', 'Ana').id;

    harness.service.post(room.id, { authorId: ana, text: '@dorian the deploy is green' });
    await flush();

    expect(announced('dm.received')).toHaveLength(1);
    expect(announced('mention.received')).toHaveLength(0);
    expect(stored()).toHaveLength(1);
  });

  it('coalesces a burst of DMs in one room into a single row', async () => {
    const harness = open();
    const room = harness.service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      harness.human
    );
    const ana = harness.authors.resolveAgent('/agents/ana', 'Ana').id;

    // `flush()` between the two: two REAL messages arrive as two separate
    // calls (a fresh HTTP request or tool round trip each), never inside one
    // synchronous turn, so this is what a burst a few seconds apart actually
    // looks like — the first notify() call settles (dedupe key indexed, row
    // written) before the second one's own dedupe check runs.
    harness.service.post(room.id, { authorId: ana, text: 'one' });
    await flush();
    harness.service.post(room.id, { authorId: ana, text: 'two' });
    await flush();

    // Two messages, both within the dedupe window, one room — one row.
    expect(stored()).toHaveLength(1);
    expect(stored()[0].body).toBe('one');
  });

  it('never fires for an agent DMing a colleague, even with the owner forced onto the roster', async () => {
    // The three-way rule (`three-way-rule.test.ts`): an agent may open a DM
    // with another agent, and the price is the owner is seeded onto the
    // roster too. That is not a DM TO the operator, and DM.received must not
    // read "the owner is on the roster" as though it were.
    const harness = open();
    const bo = harness.authors.resolveAgent('/agents/bo', 'Bo').id;
    const room = harness.service.createRoom(
      {
        kind: 'dm',
        title: 'Pair',
        members: [harness.human],
        agentPaths: ['/agents/ana', '/agents/bo'],
      },
      harness.authors.resolveAgent('/agents/ana', 'Ana').id
    );
    expect(room.members).toHaveLength(3); // ana, bo, and the owner it forced in

    harness.service.post(room.id, { authorId: bo, text: 'want to pair on this?' });
    await flush();

    expect(stored()).toHaveLength(0);
  });

  it('respects mute: a muted DM raises no row', async () => {
    const muted = new Set<string>();
    const harness = open({ isRoomMuted: (roomId) => muted.has(roomId) });
    const room = harness.service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      harness.human
    );
    muted.add(room.id);
    const ana = harness.authors.resolveAgent('/agents/ana', 'Ana').id;

    harness.service.post(room.id, { authorId: ana, text: 'quiet please' });
    await flush();

    expect(stored()).toHaveLength(0);
  });
});

describe('a mention of the operator', () => {
  it('raises mention.received in a channel, and pierces mute', async () => {
    const harness = open({ isRoomMuted: () => true }); // every room muted
    harness.authors.setHandle(harness.human, 'dorian');
    const room = harness.service.createRoom(
      {
        kind: 'channel',
        slug: 'general',
        title: '#general',
        members: [],
        agentPaths: ['/agents/ana'],
      },
      harness.human
    );
    const ana = harness.authors.resolveAgent('/agents/ana', 'Ana').id;

    harness.service.post(room.id, { authorId: ana, text: 'cc @dorian can you look at this' });
    await flush();

    expect(announced('mention.received')).toHaveLength(1);
    const [row] = stored();
    expect(row).toMatchObject({
      kind: 'mention.received',
      title: 'Ana mentioned you in #general',
      roomId: room.id,
    });
  });

  it('never fires for the operator naming themselves', async () => {
    const harness = open();
    harness.authors.setHandle(harness.human, 'dorian');
    const room = harness.service.createRoom(
      {
        kind: 'channel',
        slug: 'general',
        title: '#general',
        members: [],
        agentPaths: ['/agents/ana'],
      },
      harness.human
    );

    harness.service.post(room.id, { authorId: harness.human, text: 'note to self @dorian' });
    await flush();

    expect(stored()).toHaveLength(0);
  });

  it('reaches the operator from a real collaborator in a bridged DM — the bug this fixes', async () => {
    // The invariant this used to get wrong: "any human author in a `dm` room
    // is the operator". A bridged private chat is minted from an unclaimed
    // chat somebody ELSE started with the bot, so its human party can be a
    // genuine collaborator — and their `@dorian` has to reach the operator
    // like any other mention, not be silently swallowed because the room
    // happens to be a DM.
    const harness = open();
    harness.authors.setHandle(harness.human, 'dorian');
    const bridged = harness.service.createBridgedRoom(bridgeDm(harness));
    expect(bridged.kind).toBe('dm');

    harness.service.postExternal(bridged.id, {
      identity: {
        platformType: 'telegram',
        instanceId: 'tg-main',
        platformUserId: '145223',
        displayName: 'Miguel',
      },
      text: '@dorian look at this',
    });
    await flush();

    expect(announced('mention.received')).toHaveLength(1);
    const [row] = stored();
    expect(row).toMatchObject({ kind: 'mention.received', roomId: bridged.id });
  });
});

describe('plain channel chatter', () => {
  it('raises nothing at all — not even a quiet row', async () => {
    const harness = open();
    const room = harness.service.createRoom(
      {
        kind: 'channel',
        slug: 'general',
        title: '#general',
        members: [],
        agentPaths: ['/agents/ana'],
      },
      harness.human
    );
    const ana = harness.authors.resolveAgent('/agents/ana', 'Ana').id;

    harness.service.post(room.id, { authorId: ana, text: 'good morning everyone' });
    await flush();

    expect(stored()).toHaveLength(0);
    expect(sent.filter(([name]) => name === 'notification')).toHaveLength(0);
  });
});

describe('read-cursor auto-read', () => {
  it('marks a dm.received row read once the room cursor passes its entry', async () => {
    const harness = open();
    const room = harness.service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      harness.human
    );
    const ana = harness.authors.resolveAgent('/agents/ana', 'Ana').id;

    const entry = harness.service.post(room.id, { authorId: ana, text: 'ping' });
    await flush();
    expect(stored()[0].readAt).toBeUndefined();

    harness.service.setReadCursor(room.id, harness.human, entry.seq);
    await flush();

    expect(stored()[0].readAt).toBeDefined();
  });

  it('leaves it unread while the cursor has not reached it yet', async () => {
    // Two separate mentions rather than two DMs: `dm.received` dedupes per
    // ROOM (a burst is one row, see the coalescing test above), which would
    // make two rows in one DM room impossible to produce here regardless of
    // the cursor. `mention.received` dedupes per ENTRY, so it is what
    // actually exercises "the cursor passed row A but not row B".
    const harness = open();
    harness.authors.setHandle(harness.human, 'dorian');
    const room = harness.service.createRoom(
      {
        kind: 'channel',
        slug: 'general',
        title: '#general',
        members: [],
        agentPaths: ['/agents/ana'],
      },
      harness.human
    );
    const ana = harness.authors.resolveAgent('/agents/ana', 'Ana').id;

    // A first mention the cursor will pass, then a second that stays ahead of it.
    const first = harness.service.post(room.id, { authorId: ana, text: '@dorian one' });
    harness.service.post(room.id, { authorId: ana, text: '@dorian two' });
    await flush();

    harness.service.setReadCursor(room.id, harness.human, first.seq);
    await flush();

    const rows = stored();
    expect(rows.find((r) => r.body === '@dorian one')?.readAt).toBeDefined();
    expect(rows.find((r) => r.body === '@dorian two')?.readAt).toBeUndefined();
  });
});

/** A bridge request for the operator's own private Telegram chat with Ana. */
function bridgeDm(harness: RoomHarness): CreateBridgedRoomRequest {
  return {
    adapterId: 'tg-main',
    chatId: '555',
    bindingId: 'binding-ana',
    chatType: 'private',
    channelType: null,
    title: 'Ana',
    agentPath: '/agents/ana',
    operatorAuthorId: harness.human,
  };
}
