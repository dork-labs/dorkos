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
import { DIRECTORY_MEMBERSHIP_VECTORS } from '@dorkos/test-utils';
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

describe('isRowActive on an agent row', () => {
  /**
   * The open session, as the router reports it.
   *
   * @param cwd - The session's working directory.
   */
  function openSessionAt(cwd: string | null): SidebarTarget {
    return { kind: 'session', sessionId: 'sess-1', agentPath: '/work/project', cwd };
  }

  it('lights the agent whose folder the open session is running in', () => {
    // The plain case, and the one exact equality already got right.
    expect(
      isRowActive({ kind: 'agent', path: '/work/project' }, openSessionAt('/work/project'))
    ).toBe(true);
  });

  it('lights the agent when the session is running in a subfolder (DOR-1550)', () => {
    // The session is already IN this agent's list (`selectAgentSessions` has
    // used the subtree rule since DOR-674); the row staying dark while its own
    // conversation is open reads as the wrong agent being open.
    expect(
      isRowActive(
        { kind: 'agent', path: '/work/project' },
        openSessionAt('/work/project/packages/api')
      )
    ).toBe(true);
  });

  it('leaves an agent dark for a session with no working directory at all', () => {
    // A cwd-less session belongs to no agent (DOR-202) — including no agent's
    // active tint.
    expect(isRowActive({ kind: 'agent', path: '/work/project' }, openSessionAt(null))).toBe(false);
  });

  describe.each(DIRECTORY_MEMBERSHIP_VECTORS)(
    'membership vector: $name',
    ({ root, candidate, within }) => {
      it(`${within ? 'lights' : 'leaves dark'} the agent row`, () => {
        // The tint answers the SAME table as the session list it is a tint for.
        expect(isRowActive({ kind: 'agent', path: root }, openSessionAt(candidate))).toBe(within);
      });
    }
  );
});
