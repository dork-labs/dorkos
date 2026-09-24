/**
 * What the request card is told about itself (spec `agent-permissions` D7):
 * whether Always allow is on offer, whether the agent asked past Blocked, and
 * which room's turn raised it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

import { ApprovalService, hashApprovalInput } from '../index.js';
import { eventFanOut } from '../../event-fan-out.js';

/** A token-shaped value, the kind the summary sweep hides. */
const TOKEN = 'a3f9c2e1b4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9';

const BASE = {
  capabilityId: 'rooms.create',
  inputHash: hashApprovalInput({ title: 'proj-lunar' }),
  summary: '"DorkBot" wants to run "Open a room"',
  requestedBy: 'DorkBot',
};

describe('the request card an approval projects', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers Always allow only for a named agent, in an area that is not a floor', () => {
    const approvals = new ApprovalService(db);
    const offered = approvals.request({ ...BASE, requestedByPath: '/a', area: 'rooms' });
    const floor = approvals.request({ ...BASE, requestedByPath: '/a', area: 'reach' });
    const noArea = approvals.request({ ...BASE, requestedByPath: '/a', area: null });
    const anonymous = approvals.request({ ...BASE, area: 'rooms' });

    expect(approvals.getPending(offered.approvalId)?.alwaysOffered).toBe(true);
    expect(approvals.getPending(floor.approvalId)?.alwaysOffered).toBe(false);
    expect(approvals.getPending(noArea.approvalId)?.alwaysOffered).toBe(false);
    expect(approvals.getPending(anonymous.approvalId)?.alwaysOffered).toBe(false);
    // The grant route reads the same answer from the same row.
    expect(approvals.answerScope(floor.approvalId)).toMatchObject({
      alwaysOffered: false,
      area: 'reach',
    });
  });

  it('carries a blocked request and its reason, swept for secrets and capped', () => {
    const approvals = new ApprovalService(db);
    const ticket = approvals.request({
      ...BASE,
      requestedByPath: '/a',
      area: 'rooms',
      blockedRequest: { reason: `use ${TOKEN} ${'please '.repeat(200)}` },
    });

    const card = approvals.getPending(ticket.approvalId)!;
    expect(card.blockedRequest).toBe(true);
    expect(card.requestReason).not.toContain(TOKEN);
    expect(card.requestReason!.length).toBeLessThanOrEqual(500);
    // An ordinary card says nothing about it.
    const plain = approvals.request({ ...BASE, area: 'rooms' });
    expect(approvals.getPending(plain.approvalId)).not.toHaveProperty('blockedRequest');
    expect(approvals.getPending(plain.approvalId)).not.toHaveProperty('requestReason');
  });

  it('names the room whose turn raised it, read when the card is read', () => {
    const rooms = new Map<string, string>();
    const approvals = new ApprovalService(db, { roomForSession: (id) => rooms.get(id) });
    const ticket = approvals.request({
      ...BASE,
      area: 'rooms',
      requestingSession: { sessionId: 'placeholder-1' },
    });
    expect(approvals.getPending(ticket.approvalId)).not.toHaveProperty('roomId');

    // The room-session binding caught up (a room turn's id moved mid-turn): the
    // next read follows it rather than a copy stored at request time.
    rooms.set('placeholder-1', 'room-lunar');
    expect(approvals.getPending(ticket.approvalId)?.roomId).toBe('room-lunar');
    expect(approvals.listPending()[0]?.roomId).toBe('room-lunar');
  });

  it('still draws the card when the room lookup fails', () => {
    const approvals = new ApprovalService(db, {
      roomForSession: () => {
        throw new Error('rooms are down');
      },
    });
    const ticket = approvals.request({
      ...BASE,
      area: 'rooms',
      requestingSession: { sessionId: 's-1' },
    });
    expect(approvals.getPending(ticket.approvalId)).toMatchObject({ area: 'rooms' });
    expect(approvals.getPending(ticket.approvalId)).not.toHaveProperty('roomId');
  });
});
