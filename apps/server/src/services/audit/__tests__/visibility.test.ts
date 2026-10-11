/**
 * The one reader rule (spec `audit-trail` §3.4): `canRead` for audit rows,
 * its SQL form `readableBy`, and sessions read through the same function.
 */
import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AuditVisibility } from '@dorkos/shared/audit-schemas';
import { AuditLog } from '../audit-log.js';
import { canRead, OWNER_READER, type AuditReader } from '../visibility.js';
import {
  canReadSession,
  readableSessionIds,
  sessionVisibilities,
  initSessionVisibility,
  resetSessionVisibility,
  SESSION_LOOKUP_CHUNK,
} from '../session-visibility.js';
import { sessionVisibilityForOrigin, type TurnOrigin } from '../../session/origin/turn-origin.js';

const AGENT: AuditReader = { kind: 'agent', accountId: '01AGENTRESEARCHER' };
const OTHER: AuditReader = { kind: 'agent', accountId: '01AGENTWRITER' };

describe('canRead', () => {
  const rows: [AuditVisibility, string[] | undefined][] = [
    ['space', undefined],
    ['participants', ['install:inst-1']],
    ['participants', ['install:inst-1', '01AGENTRESEARCHER']],
    ['admins', undefined],
  ];

  it('lets the owner read every row', () => {
    for (const [visibility, participants] of rows) {
      expect(canRead(OWNER_READER, { visibility, participants })).toBe(true);
    }
  });

  it('lets an agent read space rows and the private rows it is in, never admins rows', () => {
    expect(
      rows.map(([visibility, participants]) => canRead(AGENT, { visibility, participants }))
    ).toEqual([true, false, true, false]);
    expect(
      rows.map(([visibility, participants]) => canRead(OTHER, { visibility, participants }))
    ).toEqual([true, false, false, false]);
  });

  it('is what the SQL form selects, row for row', () => {
    const log = new AuditLog(createTestDb());
    for (const [visibility, participants] of rows) {
      log.record({
        actor: { accountId: 'system', kind: 'system', name: 'DorkOS' },
        source: { surface: 'system' },
        action: `test.${visibility}`,
        operation: 'execute',
        outcome: 'ok',
        summary: 'A row',
        visibility,
        ...(participants ? { participants } : {}),
      });
    }
    // A participant id that merely CONTAINS the reader's id is not the reader.
    log.record({
      actor: { accountId: 'system', kind: 'system', name: 'DorkOS' },
      source: { surface: 'system' },
      action: 'test.lookalike',
      operation: 'execute',
      outcome: 'ok',
      summary: 'A row',
      visibility: 'participants',
      participants: ['x01AGENTRESEARCHERx'],
    });
    for (const reader of [OWNER_READER, AGENT, OTHER]) {
      const all = log.query({ limit: 200 }, OWNER_READER).events;
      const expected = all.filter((event) => canRead(reader, event)).map((event) => event.seq);
      expect(log.query({ limit: 200 }, reader).events.map((event) => event.seq)).toEqual(expected);
    }
  });
});

describe('sessionVisibilityForOrigin', () => {
  it('maps each origin as the spec table says', () => {
    const table: Record<TurnOrigin['kind'], 'space' | 'participants'> = {
      interactive: 'participants',
      'relay-binding': 'participants',
      room: 'space',
      schedule: 'space',
      'agent-dm': 'space',
      'outside-sender': 'space',
      'connector-event': 'space',
      'agent-launch': 'space',
      'extension-start': 'space',
      'extension-message': 'space',
      'chat-message': 'space',
      'account-handoff': 'participants',
      'account-resume': 'participants',
      'test-harness': 'participants',
    };
    for (const [kind, expected] of Object.entries(table)) {
      expect([kind, sessionVisibilityForOrigin(kind as TurnOrigin['kind'])]).toEqual([
        kind,
        expected,
      ]);
    }
  });

  it('takes every origin kind and nothing else', () => {
    expectTypeOf(sessionVisibilityForOrigin).parameter(0).toEqualTypeOf<TurnOrigin['kind']>();
  });
});

describe('sessionVisibilities', () => {
  const stored: Record<string, string> = {
    chat: 'interactive',
    run: 'schedule',
    'dm-turn': 'room',
    'bridged-turn': 'room',
    'channel-turn': 'room',
    'orphan-turn': 'room',
  };
  const roomClass: Record<string, 'space' | 'participants'> = {
    'dm-turn': 'participants',
    'bridged-turn': 'participants',
    'channel-turn': 'space',
    'legacy-room': 'space',
    'legacy-dm': 'participants',
  };
  const launchOriginsOf = vi.fn(
    (ids: readonly string[]) =>
      new Map(ids.flatMap((id) => (stored[id] ? [[id, stored[id]] as const] : [])))
  );
  const deps = {
    launchOriginsOf,
    resolveRoomVisibility: (ids: readonly string[]) =>
      new Map(ids.flatMap((id) => (roomClass[id] ? [[id, roomClass[id]] as const] : []))),
    resolveTaskOrigins: (ids: readonly string[]) =>
      new Map(ids.filter((id) => id === 'legacy-run').map((id) => [id, {} as never])),
  };

  it('reads the stored origin first', () => {
    const answers = sessionVisibilities(['chat', 'run'], deps);
    expect(Object.fromEntries(answers)).toEqual({ chat: 'participants', run: 'space' });
  });

  it('lets the room decide a room turn: a DM or a bridged chat is private, a channel is not', () => {
    const answers = sessionVisibilities(
      ['dm-turn', 'bridged-turn', 'channel-turn', 'orphan-turn'],
      deps
    );
    expect(Object.fromEntries(answers)).toEqual({
      'dm-turn': 'participants',
      'bridged-turn': 'participants',
      'channel-turn': 'space',
      'orphan-turn': 'participants',
    });
  });

  it('keeps every room turn private without the room lookup', () => {
    const answers = sessionVisibilities(['channel-turn'], { launchOriginsOf });
    expect(answers.get('channel-turn')).toBe('participants');
  });

  it('derives a session with no stored origin: a task run or a channel turn is agent work', () => {
    const answers = sessionVisibilities(['legacy-run', 'legacy-room', 'legacy-dm'], deps);
    expect(Object.fromEntries(answers)).toEqual({
      'legacy-run': 'space',
      'legacy-room': 'space',
      'legacy-dm': 'participants',
    });
  });

  it('treats an unknown session, or an origin this build does not know, as private', () => {
    const answers = sessionVisibilities(['nobody', 'odd'], {
      ...deps,
      launchOriginsOf: (ids) => new Map(ids.filter((id) => id === 'odd').map((id) => [id, 'x'])),
    });
    expect(Object.fromEntries(answers)).toEqual({ nobody: 'participants', odd: 'participants' });
  });

  it('reads a chat carried to another account as the chat it continues', () => {
    const origins: Record<string, string> = {
      'spin-off': 'agent-launch',
      'spin-off-on-b': 'account-handoff',
      'person-on-b': 'account-handoff',
    };
    const answers = sessionVisibilities(['spin-off-on-b', 'person-on-b'], {
      launchOriginsOf: (ids) =>
        new Map(ids.flatMap((id) => (origins[id] ? [[id, origins[id]] as const] : []))),
      resolveStartedBy: (ids) =>
        new Map(
          ids
            .filter((id) => id === 'spin-off-on-b')
            .map((id) => [id, { carried: true, startedBySessionId: 'spin-off' } as never])
        ),
    });
    expect(Object.fromEntries(answers)).toEqual({
      'spin-off-on-b': 'space',
      'person-on-b': 'participants',
    });
  });

  it('reads stored origins in batches, never one query per session', () => {
    launchOriginsOf.mockClear();
    const ids = Array.from({ length: SESSION_LOOKUP_CHUNK + 1 }, (_, i) => `s${i}`);
    expect(sessionVisibilities(ids, deps).size).toBe(ids.length);
    expect(launchOriginsOf.mock.calls.map(([batch]) => batch.length)).toEqual([
      SESSION_LOOKUP_CHUNK,
      1,
    ]);
  });
});

describe('reading sessions', () => {
  it('is canRead: agents read agent work only, the owner reads everything', () => {
    expect(canReadSession(AGENT, 'space')).toBe(true);
    expect(canReadSession(AGENT, 'participants')).toBe(false);
    expect(canReadSession(OWNER_READER, 'participants')).toBe(true);
  });

  it('lets a chat read a private chat that started it, and nothing wider', () => {
    expect(canReadSession(AGENT, 'participants', { startedReader: true })).toBe(true);
    expect(canReadSession(AGENT, 'participants', { startedReader: false })).toBe(false);
    expect(canReadSession(OTHER, 'participants')).toBe(false);
  });

  it('lets only a room’s agent members read its sessions', () => {
    const room = { members: ['01AGENTRESEARCHER'] };
    expect(canReadSession(AGENT, room)).toBe(true);
    expect(canReadSession(OTHER, room)).toBe(false);
    expect(canReadSession(OWNER_READER, room)).toBe(true);
  });

  it('refuses agents every session while no lookup is set', () => {
    resetSessionVisibility();
    expect([...readableSessionIds(AGENT, ['a', 'b'])]).toEqual([]);
    expect([...readableSessionIds(OWNER_READER, ['a', 'b'])]).toEqual(['a', 'b']);
  });

  it('reads through the lookup set at startup', () => {
    initSessionVisibility(
      (ids) => new Map(ids.map((id) => [id, id === 'run' ? 'space' : 'participants'] as const))
    );
    try {
      expect([...readableSessionIds(AGENT, ['chat', 'run'])]).toEqual(['run']);
    } finally {
      resetSessionVisibility();
    }
  });
});
