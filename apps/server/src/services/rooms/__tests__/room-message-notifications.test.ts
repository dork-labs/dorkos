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

/**
 * The operator's own Telegram account, as the bridge presents it.
 *
 * Deliberately not distinguishable from a stranger's by anything in this
 * object — that is the whole reason DOR-1778 needs a declared link rather than
 * a heuristic.
 */
const OPERATORS_PHONE = {
  platformType: 'telegram',
  instanceId: 'tg-main',
  platformUserId: '900900',
  displayName: 'Dorian',
} as const;

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

describe('a DM to the operator', () => {
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

  it('raises dm.received for a real person writing in a bridged DM (DOR-1392)', async () => {
    // The bug: `isDirectMessage` used to also require `author.kind ===
    // 'agent'`, so a colleague messaging the bot from Telegram — the message
    // with the strongest claim on the operator's attention — was the one kind
    // of DM that stayed silent. The room decides, not who typed.
    const harness = open();
    const bridged = harness.service.createBridgedRoom(bridgeDm(harness));
    expect(bridged.kind).toBe('dm');

    harness.service.postExternal(bridged.id, {
      identity: {
        platformType: 'telegram',
        instanceId: 'tg-main',
        platformUserId: '145223',
        displayName: 'Miguel',
      },
      text: 'on my way, be there in 10',
    });
    await flush();

    expect(announced('dm.received')).toHaveLength(1);
    const [row] = stored();
    expect(row).toMatchObject({
      kind: 'dm.received',
      title: 'Miguel messaged you',
      body: 'on my way, be there in 10',
      roomId: bridged.id,
    });
    expect(row.readAt).toBeUndefined();
  });

  it('respects mute for a real person too: a muted bridged DM raises no row', async () => {
    // A MUTATION GUARD, not a red-before case: this passed before DOR-1392 too,
    // because nothing notified at all. It earns its place by failing if the
    // widened gate ever forgets `roomMuted` — the kind's own rules did not
    // change, and a human author gets the same mute, the same per-room dedupe
    // and the same read-clear an agent author has always had.
    const muted = new Set<string>();
    const harness = open({ isRoomMuted: (roomId) => muted.has(roomId) });
    const bridged = harness.service.createBridgedRoom(bridgeDm(harness));
    muted.add(bridged.id);

    harness.service.postExternal(bridged.id, {
      identity: {
        platformType: 'telegram',
        instanceId: 'tg-main',
        platformUserId: '145223',
        displayName: 'Miguel',
      },
      text: 'you around?',
    });
    await flush();

    expect(stored()).toHaveLength(0);
  });

  it("echoes the operator's own phone leg back at them while that account is still a stranger", async () => {
    // The negative half of DOR-1778, and the reason the link had to be
    // DECLARED rather than guessed: an external identity nobody has claimed is
    // a stranger, whether or not it happens to be the operator. This is the
    // pre-link state and it must not change — the same code path carries every
    // real collaborator's message.
    const harness = open();
    const bridged = harness.service.createBridgedRoom(bridgeDm(harness));

    harness.service.postExternal(bridged.id, { identity: OPERATORS_PHONE, text: 'ana, status?' });
    await flush();

    expect(stored()).toHaveLength(1);
    expect(stored()[0].kind).toBe('dm.received');
  });

  it("stays silent for the operator's own phone leg once they say that account is them", async () => {
    // DOR-1778, the inversion of the case above. The operator texting their own
    // agent from their own phone posts as a `platform:` author; the link is what
    // lets the one guard at the top of `notifyRoomMessage` recognise it as their
    // own voice, and their own words have never earned them a notification.
    const harness = open();
    const bridged = harness.service.createBridgedRoom(bridgeDm(harness));
    const phone = harness.authors.resolveExternal(OPERATORS_PHONE);
    harness.authors.linkToOwner(phone.id, null);

    harness.service.postExternal(bridged.id, { identity: OPERATORS_PHONE, text: 'ana, status?' });
    await flush();

    expect(stored()).toHaveLength(0);
  });

  it('still raises dm.received for somebody ELSE after the operator links their own phone', async () => {
    // The over-suppression guard. A link is about ONE identity: claiming your
    // own phone must not turn the bridged DM into a room that notifies nobody,
    // which is the failure mode that would be invisible until a colleague's
    // message went missing.
    const harness = open();
    const bridged = harness.service.createBridgedRoom(bridgeDm(harness));
    harness.authors.linkToOwner(harness.authors.resolveExternal(OPERATORS_PHONE).id, null);

    harness.service.postExternal(bridged.id, {
      identity: {
        platformType: 'telegram',
        instanceId: 'tg-main',
        platformUserId: '145223',
        displayName: 'Miguel',
      },
      text: 'on my way, be there in 10',
    });
    await flush();

    expect(announced('dm.received')).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ title: 'Miguel messaged you' });
  });

  it('goes back to notifying the moment the operator takes the link back', async () => {
    // The mapping is revocable, and revoking it has to reach the very next
    // message rather than the next server start — the predicate is read per
    // check for exactly this.
    const harness = open();
    const bridged = harness.service.createBridgedRoom(bridgeDm(harness));
    const phone = harness.authors.resolveExternal(OPERATORS_PHONE);
    harness.authors.linkToOwner(phone.id, null);
    harness.authors.unlinkFromOwner(phone.id);

    harness.service.postExternal(bridged.id, { identity: OPERATORS_PHONE, text: 'ana, status?' });
    await flush();

    expect(stored()).toHaveLength(1);
  });

  it('keeps the link across the install gaining a login', async () => {
    // `bindOwner` rebinds the `'local'` sentinel onto the account key in place,
    // because it is the same person — so a claim made before login was turned on
    // is still a true statement afterwards. Leaving it behind would silently
    // revoke it, and the operator would only find out by being notified about
    // their own messages again.
    const harness = open();
    const bridged = harness.service.createBridgedRoom(bridgeDm(harness));
    harness.authors.linkToOwner(harness.authors.resolveExternal(OPERATORS_PHONE).id, null);

    harness.setOwner('user-dorian');

    harness.service.postExternal(bridged.id, { identity: OPERATORS_PHONE, text: 'ana, status?' });
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

  it('reaches the operator from a real collaborator in a bridged group chat', async () => {
    // The invariant this used to get wrong: "any human author in a bridged
    // room is the operator". A bridge is minted from a chat somebody ELSE
    // started with the bot, so its human party can be a genuine collaborator —
    // and their `@dorian` has to reach the operator like any other mention.
    const harness = open();
    harness.authors.setHandle(harness.human, 'dorian');
    const bridged = harness.service.createBridgedRoom({
      ...bridgeDm(harness),
      chatId: '556',
      chatType: 'group',
      channelType: 'group',
      title: 'launch crew',
    });
    expect(bridged.kind).toBe('channel');

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

  it('stays silent when the operator spells their own handle from their own phone', async () => {
    // The second half DOR-1778 retires, and it falls out of the SAME guard: the
    // author is weighed before the mentions are, so an `@dorian` the operator
    // typed on their phone is their own handle in their own message. A bridged
    // GROUP rather than a DM, so nothing here is explained by the DM collapse.
    const harness = open();
    harness.authors.setHandle(harness.human, 'dorian');
    const group = harness.service.createBridgedRoom({
      ...bridgeDm(harness),
      chatId: '556',
      chatType: 'group',
      channelType: 'group',
      title: 'launch crew',
    });
    harness.authors.linkToOwner(harness.authors.resolveExternal(OPERATORS_PHONE).id, null);

    harness.service.postExternal(group.id, {
      identity: OPERATORS_PHONE,
      text: '@dorian remember to ship this',
    });
    await flush();

    expect(stored()).toHaveLength(0);
  });

  it('still reaches the operator when somebody else names them in that same group', async () => {
    // The over-suppression guard for mentions, run against the identical room
    // and the identical text as the case above — only the author differs.
    const harness = open();
    harness.authors.setHandle(harness.human, 'dorian');
    const group = harness.service.createBridgedRoom({
      ...bridgeDm(harness),
      chatId: '556',
      chatType: 'group',
      channelType: 'group',
      title: 'launch crew',
    });
    harness.authors.linkToOwner(harness.authors.resolveExternal(OPERATORS_PHONE).id, null);

    harness.service.postExternal(group.id, {
      identity: {
        platformType: 'telegram',
        instanceId: 'tg-main',
        platformUserId: '145223',
        displayName: 'Miguel',
      },
      text: '@dorian remember to ship this',
    });
    await flush();

    expect(announced('mention.received')).toHaveLength(1);
  });

  it('reaches the operator when a collaborator names the phone they claimed', async () => {
    // The ADDITION half of the same predicate, and the half the two cases above
    // cannot reach: they exit at the author gate before any mention is weighed.
    // Here the author is somebody else, so the scan actually runs — and "this
    // account is me" has to mean an `@` naming it names ME. Without the claim
    // consulted on the mention side, an `@` at the operator's own phone handle
    // reaches nobody at all: the handle is the phone's, not the local row's.
    const harness = open();
    const group = harness.service.createBridgedRoom({
      ...bridgeDm(harness),
      chatId: '556',
      chatType: 'group',
      channelType: 'group',
      title: 'launch crew',
    });
    // The operator says something in the group first, which is what puts their
    // phone on that roster — a mention resolves against the room's members, so
    // an identity that has never spoken there is not addressable there. Setup
    // only: this post is not a second proof of the suppression half, because it
    // raises nothing either way (it is a plain channel line naming nobody).
    const phone = harness.service.postExternal(group.id, {
      identity: OPERATORS_PHONE,
      text: 'morning all',
    }).author;
    harness.authors.linkToOwner(phone.id, null);
    await flush();
    expect(stored()).toHaveLength(0);
    // Read back rather than spelled: the qualified handle an external author is
    // minted with is the handle grammar's to decide, and a literal here would
    // silently stop naming anybody the day that derivation changed.
    const phoneHandle = harness.authors.getById(phone.id)?.handle;
    expect(phoneHandle).toBeTruthy();

    harness.service.postExternal(group.id, {
      identity: {
        platformType: 'telegram',
        instanceId: 'tg-main',
        platformUserId: '145223',
        displayName: 'Miguel',
      },
      text: `@${phoneHandle} can you take a look`,
    });
    await flush();

    expect(announced('mention.received')).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ kind: 'mention.received', roomId: group.id });
  });

  it('collapses into dm.received when the collaborator names the operator inside the DM', async () => {
    // The DM collapse applies to a human author exactly as it does to an
    // agent's: one message, one banner. The operator still hears it — as
    // "Miguel messaged you" rather than "Miguel mentioned you in Ana".
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

    expect(announced('dm.received')).toHaveLength(1);
    expect(announced('mention.received')).toHaveLength(0);
    expect(stored()).toHaveLength(1);
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
