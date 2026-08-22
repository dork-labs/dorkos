/**
 * Which sidebar row looks open — including on Home, which draws a room without
 * having a room "active" (spec `one-bar-header` §3.5, phase R1).
 *
 * **The scoping is the thing under test, not just the tint.** Home IS #team, so
 * its row has to light up on `/` — but the sidebar's `activeTarget` feeds the
 * scroll anchor, the working rollup and Today's membership, and teaching it that
 * `/` means "the #team room is open" pinned #team into Today and moved the
 * anchor on every visit to the dashboard. So the highlight travels on its own
 * narrow channel (`homeRoomId`), and these cases pin both halves: the row lights,
 * and nothing else is asked to.
 */
import { describe, it, expect } from 'vitest';
import type { SidebarTarget } from '../model/build-sidebar-model';
import { isRowActive } from '../ui/SidebarModelRow';

const TEAM = 'room-team';

const teamRow: SidebarTarget = { kind: 'room', roomId: TEAM, roomKind: 'channel' };
const otherRow: SidebarTarget = { kind: 'room', roomId: 'room-other', roomKind: 'channel' };
const teamThreadRow: SidebarTarget = {
  kind: 'room',
  roomId: TEAM,
  roomKind: 'thread',
  rootEntryId: 'entry-9',
};

describe('isRowActive on Home', () => {
  it('lights #team’s row on /, where nothing is "active" at all', () => {
    // The whole point: `/` has no active target, and deliberately never gets
    // one. Without the third argument this row would sit unlit while the page
    // beside it drew that very room.
    expect(isRowActive(teamRow, null, TEAM)).toBe(true);
  });

  it('leaves every other room dark on Home', () => {
    expect(isRowActive(otherRow, null, TEAM)).toBe(false);
  });

  it('lights the channel row and NOT the thread row that shares its id', () => {
    // A thread and its channel are two rows carrying one `roomId`. Lighting both
    // gives Home two tinted rows and an `aria-current="page"` that is no longer
    // unique — which is the handle scroll-to-active finds its anchor by.
    expect(isRowActive(teamThreadRow, null, TEAM)).toBe(false);
  });

  it('changes nothing anywhere else: off Home there is no home room to match', () => {
    // `homeRoomId` is `null` on every route but `/`, so the ordinary rules are
    // untouched — this is an addition to the tint, not a rewrite of it.
    expect(isRowActive(teamRow, null, null)).toBe(false);
    expect(isRowActive(teamRow, teamRow, null)).toBe(true);
    expect(isRowActive(otherRow, teamRow, null)).toBe(false);
  });

  it('still lights a room the ordinary way when both could answer', () => {
    expect(isRowActive(otherRow, otherRow, TEAM)).toBe(true);
  });
});
