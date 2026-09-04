import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';

// One server, one room list, like every spec in this folder.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * The owner sees every room on the install (DOR-1612) — asserted at the
 * CLIENT, not just at `RoomService.seesEveryRoom` (which `member-rooms.test.ts`
 * and `room-service.test.ts` already pin server-side).
 *
 * **Why this needs its own spec rather than riding `room-row-menu.spec.ts`.**
 * That file's "leaves a one-agent room" test reaches the identical roster
 * shape — the owner off a room's `room_members` — as a side effect of proving
 * Leave/Join work. A regression in `useRooms`/`useRoomsByKind` silently
 * filtering a non-member room, or a crash reading `unreadCount: null`, would
 * fail that test too, but for the wrong stated reason: its assertions and its
 * name are about the LEAVE gesture, not about the visibility guarantee. This
 * spec seeds the same shape directly (no UI Leave click in the middle) and
 * asserts only the guarantee itself, so a break here says what actually broke.
 *
 * **Why removing the owner via the API is the honest seed, not a shortcut.**
 * `RoomService.createRoom` joins its caller automatically
 * (`@param creatorAuthorId - The author opening the room; joined
 * automatically`), and every room this suite can create over HTTP is created
 * by the owner (there is no login in this suite, so the caller always resolves
 * to the operator) — so there is no create call that skips her. A room whose
 * roster never included her at all is reachable only by having an AGENT create
 * it (the three-way rule permits a solo agent channel with nobody else on the
 * roster), which needs a verified agent identity token this suite has no route
 * to mint over HTTP. That gap does not weaken this test: the client carries
 * exactly one signal for "is the viewer a member", `unreadCount === null`
 * (`RoomRow.tsx`'s `isMember`, `ChannelComposer.tsx`'s same check) — there is
 * no second field recording WHY it is null. A room the owner left and a room
 * she was never on render identically by construction, so exercising "left"
 * exercises "never joined" too.
 *
 * No Claude SDK or API key: the agent is silent, so nothing here starts a real
 * turn.
 */
test.describe('Rooms — the owner sees every room, on or off its roster @smoke', () => {
  test('a room the owner is not a member of still lists, opens, and reads back — with no unread badge', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-owner-sees-all-${roomsApi.runId}`;
    const ana = await roomsApi.registerAgent('Ana', '🦊', '#6d5ae0');
    const room = await roomsApi.createChannel(slug, slug, [ana]);
    await roomsApi.postEntries(room.id, ['a note before I left the roster']);

    const owner = room.members.find((m) => m.author.kind === 'human');
    if (!owner) {
      throw new Error(
        'the creator did not auto-join this channel — createRoom no longer joins its caller, ' +
          'so this test cannot reach the roster shape it is about'
      );
    }
    await roomsApi.removeMember(room.id, owner.author.id);

    // A fresh navigation rather than a live re-render off an existing cache —
    // this is the cold `GET /api/rooms` a reader gets on first load, which is
    // the actual claim under test: `RoomService.listRooms` includes the room
    // for the owner (`seesEveryRoom`), and nothing between the wire and the
    // sidebar row — `useRooms`, `useRoomsByKind`, `RoomRow` — filters it back
    // out for not being a member.
    await page.goto('/channels');
    const row = roomsPage.row(`#${slug}`);
    await expect(row).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    // Exact, not `.toContainText`: the one assertion that catches a regression
    // in either direction. An unread count folded into the name ("… 1 unread")
    // would mean `unreadCount: null` — the only signal a non-member has at all
    // — stopped being honoured (room-conduct.md: a non-member's count is
    // `null`, drawn as no badge, never a repurposed zero). Losing "You're not
    // in this channel" would mean the row can no longer be told apart from one
    // this reader can actually post in. The mark names the room's state and
    // never a past action, because `unreadCount: null` is equally true of a
    // room she left and one she was never added to (DOR-1620).
    //
    // Coupled to `RoomRow`'s full name, not just the membership half: it also
    // renders a "Muted" mark independently of `isMember` (`RoomRow.tsx`), so a
    // future default that mutes a freshly-seeded room would fail this exact
    // string for a reason that has nothing to do with membership. A red here
    // is worth checking against mute state before assuming this guarantee broke.
    await expect(row).toHaveAccessibleName(`#${slug} You're not in this channel`);

    await row.click();
    await expect(page).toHaveURL(new RegExp(`id=${room.id}`));
    // The room actually opens and its history reads back. `listEntries` gates
    // on `requireVisibleRoom` (`canSee` → `seesEveryRoom`), a materially looser
    // check than the roster-only `readHistory` the agent-facing tools use — so
    // a room this reader cannot post in is not a room she cannot READ.
    await expect(page.getByText('a note before I left the roster')).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    // No composer that would lie about what a send does, and an honest way
    // back onto the roster right where the composer would be.
    await expect(page.getByRole('combobox', { name: `Message #${slug}…` })).toHaveCount(0);
    await expect(
      page.getByText("You're not in this channel. You can read it, but not add to it.")
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Join' })).toBeVisible();
  });
});
