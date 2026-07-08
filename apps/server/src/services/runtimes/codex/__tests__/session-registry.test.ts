import { describe, it, expect, beforeEach } from 'vitest';
import type { Session } from '@dorkos/shared/types';
import type { SessionListEvent } from '@dorkos/shared/session-stream';
import { CodexSessionRegistry } from '../session-registry.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION_ID = '22222222-2222-4222-8222-222222222222';

/** A durable-row Session as CodexRuntime.hydrateSessions builds them. */
function hydratedSession(overrides: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    title: 'Persisted session',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    lastMessagePreview: 'persisted preview',
    permissionMode: 'default',
    runtime: 'codex',
    cwd: '/projects/demo',
    ...overrides,
  };
}

describe('CodexSessionRegistry', () => {
  let registry: CodexSessionRegistry;

  beforeEach(() => {
    registry = new CodexSessionRegistry();
  });

  describe('hydrate', () => {
    it('inserts untracked sessions and serves them from list/get', () => {
      registry.hydrate([
        hydratedSession({ id: SESSION_ID }),
        hydratedSession({ id: OTHER_SESSION_ID, title: 'Second', cwd: '/projects/other' }),
      ]);

      expect(registry.has(SESSION_ID)).toBe(true);
      expect(registry.get(SESSION_ID)).toMatchObject({
        id: SESSION_ID,
        title: 'Persisted session',
        lastMessagePreview: 'persisted preview',
        runtime: 'codex',
      });
      expect(registry.list('/projects/demo').map((s) => s.id)).toEqual([SESSION_ID]);
      expect(registry.list('/projects/other').map((s) => s.id)).toEqual([OTHER_SESSION_ID]);
    });

    it('excludes cwd-less sessions from every project list while keeping them reachable by id (DOR-202)', () => {
      registry.hydrate([hydratedSession({ id: SESSION_ID, cwd: undefined })]);

      // Pre-fix the ghost fanned into EVERY projectDir's list.
      expect(registry.list('/projects/demo')).toEqual([]);
      expect(registry.list('/projects/other')).toEqual([]);
      expect(registry.get(SESSION_ID)?.id).toBe(SESSION_ID);
    });

    it('never overwrites a tracked session with a stale durable row', () => {
      registry.recordMessage(SESSION_ID, 'fresh in-memory message', { cwd: '/projects/demo' });
      const fresh = registry.get(SESSION_ID)!;

      registry.hydrate([
        hydratedSession({ id: SESSION_ID, title: 'stale title', lastMessagePreview: 'stale' }),
      ]);

      expect(registry.get(SESSION_ID)).toEqual(fresh);
    });

    it('is idempotent — repeat hydration inserts and emits nothing new', async () => {
      registry.hydrate([hydratedSession({ id: SESSION_ID })]);

      const events: SessionListEvent[] = [];
      const iterator = registry.subscribe();
      // Drain the inventory snapshot (one tracked session).
      events.push((await iterator.next()).value as SessionListEvent);

      registry.hydrate([hydratedSession({ id: SESSION_ID, title: 'stale re-run' })]);
      // A live event from the second hydrate would arrive before this upsert.
      registry.register(OTHER_SESSION_ID);
      events.push((await iterator.next()).value as SessionListEvent);
      await iterator.return?.(undefined);

      expect(registry.get(SESSION_ID)?.title).toBe('Persisted session');
      expect(events.map((e) => (e.type === 'session_upserted' ? e.session.id : e.type))).toEqual([
        SESSION_ID,
        OTHER_SESSION_ID,
      ]);
    });

    it('emits session_upserted per inserted session to live subscribers', async () => {
      const iterator = registry.subscribe();
      const first = iterator.next();

      registry.hydrate([
        hydratedSession({ id: SESSION_ID }),
        hydratedSession({ id: OTHER_SESSION_ID, title: 'Second' }),
      ]);

      const events = [(await first).value, (await iterator.next()).value] as SessionListEvent[];
      await iterator.return?.(undefined);

      expect(events).toEqual([
        expect.objectContaining({
          type: 'session_upserted',
          session: expect.objectContaining({ id: SESSION_ID, title: 'Persisted session' }),
        }),
        expect.objectContaining({
          type: 'session_upserted',
          session: expect.objectContaining({ id: OTHER_SESSION_ID, title: 'Second' }),
        }),
      ]);
    });

    it('emitted events carry copies that do not observe later mutations', async () => {
      const iterator = registry.subscribe();
      const first = iterator.next();

      registry.hydrate([hydratedSession({ id: SESSION_ID })]);
      registry.rename(SESSION_ID, 'renamed after hydrate');

      const event = (await first).value as SessionListEvent;
      await iterator.return?.(undefined);

      expect(event).toMatchObject({
        type: 'session_upserted',
        session: expect.objectContaining({ title: 'Persisted session' }),
      });
      expect(registry.get(SESSION_ID)?.title).toBe('renamed after hydrate');
    });
  });
});
