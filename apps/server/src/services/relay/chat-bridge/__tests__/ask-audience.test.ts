/**
 * Where an Ask's detail may go on a chat platform (spec `ask-entitlement`
 * §5.1).
 *
 * Every case here is a refusal except the first, and that ratio is the point: a
 * card carries the exact command an agent wants to run, and this predicate is
 * the only thing standing between that command and a group chat.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';

import { bridgedAskIsActionable } from '../ask-audience.js';
import type { Bridge, BridgeablePlatformChatType } from '../bridge-store.js';

/**
 * A live bridge on one chat.
 *
 * @param overrides - What this case varies.
 */
function bridgeOn(overrides: Partial<Bridge> = {}): Bridge {
  return {
    roomId: 'room_ops',
    adapterId: 'tg-main',
    chatId: '145223',
    channelType: null,
    platformChatType: 'private',
    bindingId: 'binding-ana',
    visibility: null,
    visibilityCheckedAt: null,
    platformTitle: null,
    deliverNotices: true,
    lastDeliveredSeq: 0,
    lastActivityAt: null,
    createdAt: '2026-08-19T00:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

const OWNER = { platformUserId: 'tg_owner' };
const DEPUTY = { platformUserId: 'tg_deputy' };
const STRANGER = { platformUserId: 'tg_stranger' };
const APPROVERS = ['tg_owner', 'tg_deputy'];

describe('bridgedAskIsActionable', () => {
  it('admits a private chat whose one person is on the approver list', () => {
    expect(
      bridgedAskIsActionable({
        bridge: bridgeOn(),
        externalAuthors: [OWNER],
        approvers: APPROVERS,
      })
    ).toBe(true);
  });

  it('refuses a private chat whose person is not on the list', () => {
    expect(
      bridgedAskIsActionable({
        bridge: bridgeOn(),
        externalAuthors: [STRANGER],
        approvers: APPROVERS,
      })
    ).toBe(false);
  });

  it('refuses an empty approver list, because absence is not consent', () => {
    expect(
      bridgedAskIsActionable({ bridge: bridgeOn(), externalAuthors: [OWNER], approvers: [] })
    ).toBe(false);
  });

  for (const chatType of ['group', 'supergroup'] as BridgeablePlatformChatType[]) {
    it(`refuses a ${chatType} even when everyone who has posted may approve`, () => {
      // The roster is who has SPOKEN, not who is reading. A lurker has no
      // author row at all, so admitting this would licence a leak to somebody
      // the roster cannot see.
      expect(
        bridgedAskIsActionable({
          bridge: bridgeOn({ platformChatType: chatType }),
          externalAuthors: [OWNER, DEPUTY],
          approvers: APPROVERS,
        })
      ).toBe(false);
    });
  }

  it('refuses a private chat carrying two external authors, which a migration can produce', () => {
    expect(
      bridgedAskIsActionable({
        bridge: bridgeOn(),
        externalAuthors: [OWNER, DEPUTY],
        approvers: APPROVERS,
      })
    ).toBe(false);
  });

  it('refuses a private chat with no external author at all', () => {
    expect(
      bridgedAskIsActionable({ bridge: bridgeOn(), externalAuthors: [], approvers: APPROVERS })
    ).toBe(false);
  });

  it('refuses an archived bridge, however well-formed everything else is', () => {
    expect(
      bridgedAskIsActionable({
        bridge: bridgeOn({ archivedAt: '2026-08-19T01:00:00.000Z' }),
        externalAuthors: [OWNER],
        approvers: APPROVERS,
      })
    ).toBe(false);
  });
});
