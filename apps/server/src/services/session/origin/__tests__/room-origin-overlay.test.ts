/**
 * Room turns are marked as room turns, and only room turns are.
 *
 * The defect this pins: a room's reply is an ordinary session as far as the
 * transcript-head classifier is concerned — it carries no marker of its own — so
 * every surface that lists threads listed the room AND the run underneath it,
 * twice, side by side. `room_sessions` is the server's own record of which is
 * which, and this overlay is what puts it on the wire.
 */
import { describe, it, expect } from 'vitest';
import { createMockSession } from '@dorkos/test-utils';
import { applyRoomOriginOverlay, type ResolveRoomOrigins } from '../room-origin-overlay.js';
import { type ResolveTaskOrigins } from '../task-origin-overlay.js';
import { applySessionOriginOverlays } from '../session-origin-overlays.js';

describe('applyRoomOriginOverlay', () => {
  it('marks a bound session as a room turn and names the room it answers in', () => {
    const sessions = [
      createMockSession({ id: 'bound' }),
      createMockSession({ id: 'loose' }),
      createMockSession({ id: 'dm-bound' }),
    ];
    const resolve: ResolveRoomOrigins = (ids) => {
      const map = new Map<string, { roomLabel: string; roomId: string }>();
      if (ids.includes('bound')) map.set('bound', { roomLabel: '#general', roomId: 'r1' });
      if (ids.includes('dm-bound')) map.set('dm-bound', { roomLabel: 'Ana', roomId: 'r2' });
      return map;
    };

    applyRoomOriginOverlay(sessions, resolve);

    expect(sessions[0].origin).toBe('room');
    expect(sessions[0].originLabel).toBe('#general');
    expect(sessions[2].origin).toBe('room');
    expect(sessions[2].originLabel).toBe('Ana');
  });

  // DOR-1157. A label is a name and names are not unique: an archived and a
  // live channel can share a slug, and a DM can be titled `#general`. A client
  // joining conversations to rooms by name had to guess between them.
  it('names the room by id as well, which is the join a name cannot make', () => {
    const sessions = [createMockSession({ id: 'bound' })];

    applyRoomOriginOverlay(
      sessions,
      () => new Map([['bound', { roomLabel: '#shipping', roomId: 'room-shipping-archived' }]])
    );

    expect(sessions[0]!.originRoomId).toBe('room-shipping-archived');
    // The label stays: it is what a person READS, and it tracks renames.
    expect(sessions[0]!.originLabel).toBe('#shipping');
  });

  it('leaves no room id on a session no room is answering with', () => {
    const sessions = [createMockSession({ id: 'loose' })];

    applyRoomOriginOverlay(sessions, () => new Map());

    expect('originRoomId' in sessions[0]!).toBe(false);
  });

  it('leaves a session no room is answering with completely untouched', () => {
    const sessions = [createMockSession({ id: 'loose' })];

    applyRoomOriginOverlay(sessions, () => new Map());

    expect(sessions[0].origin).toBeUndefined();
    expect(sessions[0].originLabel).toBeUndefined();
  });

  it('is a safe no-op when the rooms subsystem is off', () => {
    const sessions = [createMockSession({ id: 'no-rooms' })];

    expect(() => applyRoomOriginOverlay(sessions, undefined)).not.toThrow();
    expect(sessions[0].origin).toBeUndefined();
  });

  it('asks only about the sessions it was given', () => {
    const asked: string[][] = [];
    applyRoomOriginOverlay(
      [createMockSession({ id: 'a' }), createMockSession({ id: 'b' })],
      (ids) => {
        asked.push(ids);
        return new Map();
      }
    );
    expect(asked).toEqual([['a', 'b']]);
  });

  // BC-16. A room turn's prompt IS another agent's post, byte for byte
  // (`room-turn-runner.ts`), so a reading derived from the transcript is that
  // agent's activity wearing the operator's name. Only this binding knows.
  it('takes back the userLastMessageAt reading it just proved nobody wrote', () => {
    const sessions = [
      createMockSession({ id: 'bound', userLastMessageAt: '2026-03-01T09:00:00.000Z' }),
      createMockSession({ id: 'loose', userLastMessageAt: '2026-03-01T09:00:00.000Z' }),
    ];
    applyRoomOriginOverlay(sessions, (ids) =>
      ids.includes('bound')
        ? new Map([['bound', { roomLabel: '#general', roomId: 'r1' }]])
        : new Map()
    );

    // Absent, and absent as a MISSING KEY — a client asking
    // `'userLastMessageAt' in session` must not see it either.
    expect(sessions[0]!.userLastMessageAt).toBeUndefined();
    expect('userLastMessageAt' in sessions[0]!).toBe(false);
    // …and the ordinary conversation beside it keeps its reading.
    expect(sessions[1]!.userLastMessageAt).toBe('2026-03-01T09:00:00.000Z');
  });
});

describe('applySessionOriginOverlays — the order, stated once', () => {
  // Ordering is a product decision, not an accident of import order: a
  // scheduled task that posts into a room is still the task somebody scheduled.
  // Asserted against the COMPOSITE rather than two hand-sequenced calls, because
  // the composite is what every call site now runs — a test that ordered them
  // itself would keep passing however the shipped pair was ordered.
  it('lets the Pulse overlay win over the room it posted into', () => {
    const sessions = [createMockSession({ id: 's1' })];
    const resolveRoomOrigins: ResolveRoomOrigins = () =>
      new Map([['s1', { roomLabel: '#general', roomId: 'r1' }]]);
    const resolveTaskOrigins: ResolveTaskOrigins = () => new Map([['s1', { taskName: 'digest' }]]);

    applySessionOriginOverlays(sessions, { resolveRoomOrigins, resolveTaskOrigins });

    expect(sessions[0]!.origin).toBe('task');
    expect(sessions[0]!.originLabel).toBe('Scheduled task · digest');
    // …and it takes the room id with it. `Session.originRoomId` is documented
    // as present only under `origin: 'room'`; a leftover id would be a room
    // scope quietly claiming a run the wire calls a scheduled one.
    expect('originRoomId' in sessions[0]!).toBe(false);
  });

  it('marks the room turn when no scheduled run claims the session', () => {
    const sessions = [createMockSession({ id: 's1' })];

    applySessionOriginOverlays(sessions, {
      resolveRoomOrigins: () => new Map([['s1', { roomLabel: '#general', roomId: 'r1' }]]),
      resolveTaskOrigins: () => new Map(),
    });

    expect(sessions[0]!.origin).toBe('room');
    expect(sessions[0]!.originLabel).toBe('#general');
    expect(sessions[0]!.originRoomId).toBe('r1');
  });

  it('is a safe no-op on an install with both subsystems off', () => {
    const sessions = [createMockSession({ id: 's1' })];

    expect(() => applySessionOriginOverlays(sessions, {})).not.toThrow();
    expect(sessions[0]!.origin).toBeUndefined();
  });
});
