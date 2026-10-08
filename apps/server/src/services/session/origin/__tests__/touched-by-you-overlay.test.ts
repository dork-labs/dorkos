/**
 * The fourth origin step, "touched by you" (spec `your-activity-first` D5),
 * through the real ordered chain: whose a chat is follows what you did in it,
 * never how it started, and a relayed room turn or a task fire still never
 * reads as you.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { Session } from '@dorkos/shared/types';
import { applySessionOriginOverlays } from '../session-origin-overlays.js';
import type { SessionTouch } from '../session-touch-store.js';

const TRANSCRIPT = '2026-10-08T08:00:00.000Z';
const OPENED = '2026-10-08T09:00:00.000Z';
const WROTE = '2026-10-08T10:00:00.000Z';

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    createdAt: '2026-10-08T07:00:00.000Z',
    updatedAt: '2026-10-08T11:00:00.000Z',
    permissionMode: 'default',
    ...extra,
  };
}

const touches =
  (rows: Record<string, SessionTouch>) =>
  (ids: string[]): Map<string, SessionTouch> =>
    new Map(ids.filter((id) => rows[id]).map((id) => [id, rows[id]!]));

describe('touched-by-you overlay', () => {
  it('counts a room-born chat you typed in as yours', () => {
    const rows = [session('room-chat', { userLastMessageAt: TRANSCRIPT })];
    applySessionOriginOverlays(rows, {
      resolveRoomOrigins: () => new Map([['room-chat', { roomLabel: '#dorkos', roomId: 'r1' }]]),
      resolveTouches: touches({ 'room-chat': { openedAt: OPENED, wroteAt: WROTE } }),
    });
    // How it started stays visible…
    expect(rows[0]!.origin).toBe('room');
    // …but your own recorded write comes back, and the transcript's does not.
    expect(rows[0]!.userLastMessageAt).toBe(WROTE);
    expect(rows[0]!.lastTouchedByYouAt).toBe(WROTE);
  });

  it('leaves a relayed room turn with no touch exactly as the room step left it', () => {
    const rows = [session('room-turn', { userLastMessageAt: TRANSCRIPT })];
    applySessionOriginOverlays(rows, {
      resolveRoomOrigins: () => new Map([['room-turn', { roomLabel: '#general', roomId: 'r1' }]]),
      resolveTouches: touches({}),
    });
    expect('userLastMessageAt' in rows[0]!).toBe(false);
    expect('lastTouchedByYouAt' in rows[0]!).toBe(false);
  });

  it('leaves task and agent chats with no touch unchanged', () => {
    const rows = [
      session('task-chat', { userLastMessageAt: TRANSCRIPT }),
      session('agent-chat', { origin: 'agent' }),
    ];
    applySessionOriginOverlays(rows, {
      resolveTaskOrigins: () => new Map([['task-chat', { taskName: 'nightly' }]]),
      resolveTouches: touches({}),
    });
    expect(rows[0]!.origin).toBe('task');
    expect('userLastMessageAt' in rows[0]!).toBe(false);
    expect('lastTouchedByYouAt' in rows[0]!).toBe(false);
    expect(rows[1]).toEqual(session('agent-chat', { origin: 'agent' }));
  });

  it('marks a chat you only opened as touched without inventing a message time', () => {
    const rows = [session('opened-only', { origin: 'agent' })];
    applySessionOriginOverlays(rows, {
      resolveTouches: touches({ 'opened-only': { openedAt: OPENED, wroteAt: null } }),
    });
    expect(rows[0]!.lastTouchedByYouAt).toBe(OPENED);
    expect('userLastMessageAt' in rows[0]!).toBe(false);
  });

  it('keeps a later transcript reading on a chat you started yourself', () => {
    const later = '2026-10-08T12:00:00.000Z';
    const rows = [session('yours', { userLastMessageAt: later })];
    applySessionOriginOverlays(rows, {
      resolveTouches: touches({ yours: { openedAt: OPENED, wroteAt: WROTE } }),
    });
    expect(rows[0]!.userLastMessageAt).toBe(later);
    expect(rows[0]!.lastTouchedByYouAt).toBe(WROTE);
  });

  it('is a no-op with no database', () => {
    const rows = [session('yours', { userLastMessageAt: TRANSCRIPT })];
    applySessionOriginOverlays(rows, {});
    expect(rows[0]).toEqual(session('yours', { userLastMessageAt: TRANSCRIPT }));
  });
});
