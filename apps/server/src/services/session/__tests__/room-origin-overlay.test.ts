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
import { applyTaskOriginOverlay, type ResolveTaskOrigins } from '../task-origin-overlay.js';

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

  // Ordering is a product decision, not an accident of import order: a
  // scheduled task that posts into a room is still the task somebody scheduled.
  it('yields to the Pulse overlay, which runs after it at every call site', () => {
    const sessions = [createMockSession({ id: 's1' })];
    const resolveRooms: ResolveRoomOrigins = () =>
      new Map([['s1', { roomLabel: '#general', roomId: 'r1' }]]);
    const resolveTasks: ResolveTaskOrigins = () => new Map([['s1', { taskName: 'digest' }]]);

    applyRoomOriginOverlay(sessions, resolveRooms);
    applyTaskOriginOverlay(sessions, resolveTasks);

    expect(sessions[0].origin).toBe('task');
    expect(sessions[0].originLabel).toBe('Scheduled task · digest');
  });
});
