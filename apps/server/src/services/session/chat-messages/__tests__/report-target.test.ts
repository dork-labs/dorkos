/**
 * Who a spin-off reports to, past account moves on either side (spec
 * `spin-off-chats` §5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  SessionStartedByStore,
  setSessionStartedByStore,
} from '../../origin/session-started-by-store.js';
import { setRoomSeatReports } from '../chat-message-current.js';
import { deliverToRoomSeat, reportTargetOf } from '../chat-message-wiring.js';

let store: SessionStartedByStore;
let clock = 0;
const start = (sessionId: string, from: string, over: Record<string, unknown> = {}) =>
  store.insert({
    sessionId,
    kind: 'chat',
    extensionId: null,
    startedBySessionId: from,
    originExtensionId: null,
    reason: null,
    createdAt: new Date(Date.UTC(2026, 9, 9, 12, 0, clock++)).toISOString(),
    ...over,
  });

beforeEach(() => {
  store = new SessionStartedByStore(createTestDb());
  setSessionStartedByStore(store);
});
afterEach(() => setSessionStartedByStore(undefined));

describe('reportTargetOf', () => {
  it('is the chat that started it', () => {
    start('child', 'parent');
    expect(reportTargetOf('child')).toEqual({ parentSessionId: 'parent' });
  });

  it('is nobody for a chat nobody started, an extension start, or reportBack off', () => {
    expect(reportTargetOf('stranger')).toBeNull();
    store.insert({
      sessionId: 'ext',
      kind: 'extension',
      extensionId: 'flow',
      startedBySessionId: null,
      originExtensionId: 'flow',
      reason: null,
      createdAt: '2026-10-09T12:00:00.000Z',
    });
    expect(reportTargetOf('ext')).toBeNull();
    start('quiet', 'parent', { reportBack: false });
    expect(reportTargetOf('quiet')).toBeNull();
  });

  it('reports for the chat a carried chat replaced, to that chat’s starter', () => {
    start('child', 'parent');
    // The child hit its limit and was carried to account B.
    start('child-on-b', 'child', { carried: true });
    expect(reportTargetOf('child-on-b')).toEqual({ parentSessionId: 'parent' });
  });

  it('reports to where the parent was carried, not to the chat on the exhausted account', () => {
    start('child', 'parent');
    start('parent-on-b', 'parent', { carried: true });
    expect(reportTargetOf('child')).toEqual({ parentSessionId: 'parent-on-b' });
  });
});

describe('deliverToRoomSeat (DOR-3488)', () => {
  const report = { fromSessionId: 'child', fromAgentPath: '/agents/bo', text: 'Finished.' };
  afterEach(() => setRoomSeatReports(undefined));

  it('hands a report for a room’s seat to the rooms', async () => {
    const deliver = vi.fn((_seat: string, _report: unknown, onSettled?: (ran: boolean) => void) => {
      onSettled?.(true);
      return true;
    });
    setRoomSeatReports({
      seatOf: (id) => (id === 'seat' ? { roomId: 'r', authorId: 'a' } : null),
      holdsSeat: (id) => id === 'seat',
      deliver,
    });
    await expect(deliverToRoomSeat('seat', report)).resolves.toBe(true);
    expect(deliver).toHaveBeenCalledWith(
      'seat',
      expect.objectContaining(report),
      expect.any(Function)
    );
  });

  // DOR-3753: a seat that moved checks the spin-off's start against the move, so the start
  // handed in must be the server's own record of it, past any account carry.
  it('hands in when the spin-off was first started, from the server’s start record', async () => {
    const deliver = vi.fn((_seat: string, _report: unknown, onSettled?: (ran: boolean) => void) => {
      onSettled?.(true);
      return true;
    });
    setRoomSeatReports({
      seatOf: () => ({ roomId: 'r', authorId: 'a' }),
      holdsSeat: () => true,
      deliver,
    });
    start('child', 'seat');
    const firstStart = Date.parse(store.get('child')!.createdAt);
    start('child-on-b', 'child', { carried: true });

    await deliverToRoomSeat('seat', report);
    await deliverToRoomSeat('seat', { ...report, fromSessionId: 'child-on-b' });

    expect(
      deliver.mock.calls.map(([, sent]) => (sent as { startedAt?: number }).startedAt)
    ).toEqual([firstStart, firstStart]);
  });

  it('hands in no start for a spin-off with no start record', async () => {
    const deliver = vi.fn((_seat: string, _report: unknown, onSettled?: (ran: boolean) => void) => {
      onSettled?.(true);
      return true;
    });
    setRoomSeatReports({
      seatOf: () => ({ roomId: 'r', authorId: 'a' }),
      holdsSeat: () => true,
      deliver,
    });

    await deliverToRoomSeat('seat', { ...report, fromSessionId: 'unknown' });

    expect((deliver.mock.calls[0]?.[1] as { startedAt?: number }).startedAt).toBeUndefined();
  });

  it('never keeps a start the caller handed in, only the server’s record', async () => {
    const deliver = vi.fn((_seat: string, _report: unknown, onSettled?: (ran: boolean) => void) => {
      onSettled?.(true);
      return true;
    });
    setRoomSeatReports({
      seatOf: () => ({ roomId: 'r', authorId: 'a' }),
      holdsSeat: () => true,
      deliver,
    });
    start('child', 'seat');
    const recorded = Date.parse(store.get('child')!.createdAt);
    const forged = { startedAt: 0 } as object;

    await deliverToRoomSeat('seat', { ...report, ...forged });
    await deliverToRoomSeat('seat', { ...report, ...forged, fromSessionId: 'unknown' });

    expect(
      deliver.mock.calls.map(([, sent]) => (sent as { startedAt?: number }).startedAt)
    ).toEqual([recorded, undefined]);
  });

  it('throws when the seat’s turn never ran, so the report can be tried again (DOR-3720)', async () => {
    setRoomSeatReports({
      seatOf: () => ({ roomId: 'r', authorId: 'a' }),
      holdsSeat: () => true,
      deliver: (_seat, _report, onSettled) => {
        onSettled?.(false);
        return true;
      },
    });
    await expect(deliverToRoomSeat('seat', report)).rejects.toThrow('did not reach');
  });

  it('is false for a chat that is no room’s seat, or before the rooms boot', async () => {
    await expect(deliverToRoomSeat('seat', report)).resolves.toBe(false);
    const deliver = vi.fn(() => true);
    setRoomSeatReports({ seatOf: () => null, holdsSeat: () => false, deliver });
    await expect(deliverToRoomSeat('plain-chat', report)).resolves.toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });
});
