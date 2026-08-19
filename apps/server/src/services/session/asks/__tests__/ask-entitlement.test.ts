/**
 * The one predicate every Ask surface reads (spec `ask-entitlement` §2).
 *
 * The negative cases are the ones that matter. An agent clears the session gate
 * — with login off it needs no credential at all — so a policy that let it
 * merely SEE would keep the capability this spec exists to remove: holding the
 * global stream open and reading every pending shell command on the machine.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';

import { askEntitlement, type AskSubject } from '../ask-entitlement.js';
import type { CallerPrincipal } from '../../../../lib/caller-principal.js';

/** An Ask parked in a session no room owns. */
const unbound: AskSubject = { sessionId: 'sess_solo' };

/** An Ask parked in a session that answers for a room, with two approvers named. */
const roomBound: AskSubject = {
  sessionId: 'sess_room',
  roomId: 'room_ops',
  approvers: ['tg_owner', 'tg_deputy'],
  approverPlatform: 'telegram',
};

/** A person clicking a button on a chat platform. */
function bridged(platformUserId: string): CallerPrincipal {
  return { kind: 'bridged', platform: 'telegram', platformUserId };
}

describe('askEntitlement', () => {
  it('gives an agent nothing, for a room-bound and an unbound Ask alike', () => {
    expect(askEntitlement({ kind: 'agent' }, unbound)).toBe('none');
    expect(askEntitlement({ kind: 'agent' }, roomBound)).toBe('none');
  });

  it('gives the operator the answer right', () => {
    expect(askEntitlement({ kind: 'operator' }, unbound)).toBe('answer');
    expect(askEntitlement({ kind: 'operator' }, roomBound)).toBe('answer');
  });

  it('lets the person’s own program see, and never answer', () => {
    const program: CallerPrincipal = { kind: 'program', userId: 'user_owner' };
    expect(askEntitlement(program, unbound)).toBe('see');
    expect(askEntitlement(program, roomBound)).toBe('see');
  });

  it('lets an allowlisted approver answer a room-bound Ask', () => {
    expect(askEntitlement(bridged('tg_deputy'), roomBound)).toBe('answer');
  });

  it('gives a bridged caller who is not on the allowlist nothing', () => {
    expect(askEntitlement(bridged('tg_stranger'), roomBound)).toBe('none');
  });

  it('gives a bridged approver nothing when no room owns the session', () => {
    // Being named on a room's allowlist says nothing about a session that room
    // does not own, and the approvers list would not even have been resolved.
    expect(
      askEntitlement(bridged('tg_owner'), {
        sessionId: 'sess_solo',
        approvers: ['tg_owner'],
        approverPlatform: 'telegram',
      })
    ).toBe('none');
  });

  it('refuses a click from a platform the allowlist does not belong to', () => {
    // A platform user id is unique only within its own platform. A Slack
    // adapter publishing for a Telegram-bridged room would otherwise be checked
    // against Telegram's list, and a string spelled the same way in both places
    // would authorize a tool call the operator named nobody for.
    expect(
      askEntitlement({ kind: 'bridged', platform: 'slack', platformUserId: 'tg_owner' }, roomBound)
    ).toBe('none');
  });

  it('refuses when the caller could not say which platform the allowlist is for', () => {
    expect(
      askEntitlement(bridged('tg_owner'), {
        sessionId: 'sess_room',
        roomId: 'room_ops',
        approvers: ['tg_owner'],
      })
    ).toBe('none');
  });

  it('treats an empty allowlist and an absent one alike: nobody', () => {
    expect(
      askEntitlement(bridged('tg_owner'), {
        sessionId: 'sess_room',
        roomId: 'room_ops',
        approverPlatform: 'telegram',
      })
    ).toBe('none');
    expect(
      askEntitlement(bridged('tg_owner'), {
        sessionId: 'sess_room',
        roomId: 'room_ops',
        approvers: [],
        approverPlatform: 'telegram',
      })
    ).toBe('none');
  });

  it('reads the allowlist the way the setup form stores it, one id per line', () => {
    // `toIdList` tolerates the textarea shape, and going through `mayApprove`
    // rather than `Array.includes` is what keeps that true here too.
    const subject = {
      sessionId: 'sess_room',
      roomId: 'room_ops',
      approvers: ' tg_owner \n tg_deputy ' as unknown as readonly string[],
      approverPlatform: 'telegram',
    };
    expect(askEntitlement(bridged('tg_deputy'), subject)).toBe('answer');
    expect(askEntitlement(bridged('tg_stranger'), subject)).toBe('none');
  });
});
