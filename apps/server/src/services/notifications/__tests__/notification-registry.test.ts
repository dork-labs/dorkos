import { describe, it, expect } from 'vitest';
import {
  NOTIFICATION_KINDS,
  NotificationDTOSchema,
  type NotificationKind,
} from '@dorkos/shared/notification-schemas';
import {
  notificationEntry,
  resolvePerKind,
  WIRED_NOTIFICATION_KINDS,
  type NotificationPayloads,
} from '../notification-registry.js';

/**
 * One payload per kind, so every entry can be exercised. Typed against the
 * registry's own payload map: a kind whose payload changes shape breaks this
 * file at compile time rather than silently going untested.
 */
const PAYLOADS: { [K in NotificationKind]: NotificationPayloads[K] } = {
  'ask.pending': {
    sessionId: 'sess-1',
    interactionId: 'int-1',
    agentId: 'agent-1',
    sessionLabel: 'acme',
    summary: 'Wants to run Bash',
  },
  'schedule.parked': {
    taskId: 'task-1',
    taskName: 'Nightly digest',
    agentId: 'agent-1',
    proposedBy: 'An agent',
  },
  'session.error': {
    sessionId: 'sess-1',
    agentId: 'agent-1',
    sessionLabel: 'acme',
    detail: 'Ran out of turns',
  },
  'turn.completed': {
    sessionId: 'sess-1',
    agentId: 'agent-1',
    sessionLabel: 'acme',
    completedAt: '2026-08-20T00:00:00.000Z',
  },
  'run.completed': {
    runId: 'run-1',
    taskId: 'task-1',
    taskName: 'Nightly digest',
    agentId: 'agent-1',
    status: 'completed',
    duration: '2m 14s',
    detail: 'All clear',
    channelMessage: '✅ Nightly digest — done in 2m 14s. All clear',
  },
  'dm.received': {
    roomId: 'room-1',
    entryId: 'entry-1',
    entrySeq: 12,
    agentId: 'agent-1',
    fromName: 'Ana',
    preview: 'the deploy is green',
  },
  'mention.received': {
    roomId: 'room-1',
    entryId: 'entry-1',
    entrySeq: 13,
    roomName: 'general',
    agentId: 'agent-1',
    fromName: 'Ana',
    preview: 'can you look at this',
  },
  'agent.note': {
    agentId: 'agent-1',
    agentName: 'Ana',
    message: 'The migration finished.',
    sessionId: 'sess-1',
  },
  'dead-letter.created': {
    deadLetterId: 'dl-1',
    agentId: 'agent-1',
    reason: 'no endpoint accepted it',
  },
  'agent.unreachable': { agentId: 'agent-1', agentName: 'Ana' },
  'update.installed': { version: '0.61.0', previousVersion: '0.60.0' },
  'report.daily': {
    date: '2026-08-20',
    title: 'While you were away: 2 turns finished',
    summary: '2 turns finished. 1 run finished.',
  },
};

/** The tier every kind is declared at, from the spec's own table. */
const EXPECTED_TIERS: Record<NotificationKind, string> = {
  'ask.pending': 'blocking',
  'schedule.parked': 'blocking',
  'session.error': 'blocking',
  'turn.completed': 'notable',
  'run.completed': 'quiet', // the fixture above is a SUCCESS; failures are notable
  'dm.received': 'notable',
  'mention.received': 'notable',
  'agent.note': 'notable',
  'dead-letter.created': 'quiet',
  'agent.unreachable': 'quiet',
  'update.installed': 'quiet',
  'report.daily': 'quiet',
};

/** The three kinds ADR 260819-234828 says are standing conditions. */
const STANDING: NotificationKind[] = ['ask.pending', 'schedule.parked', 'session.error'];

describe('notification registry', () => {
  it('declares an entry for every kind', () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(notificationEntry(kind).kind).toBe(kind);
    }
  });

  it('builds a valid notification out of every kind', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const entry = notificationEntry(kind);
      const payload = PAYLOADS[kind];
      const location = entry.locate(payload);
      const parsed = NotificationDTOSchema.safeParse({
        id: '01J000000000000000000000',
        kind,
        tier: resolvePerKind(entry.tier, payload),
        subject: { type: entry.subjectType, id: location.subjectId },
        ...(location.agentId ? { agentId: location.agentId } : {}),
        ...(location.sessionId ? { sessionId: location.sessionId } : {}),
        ...(location.roomId ? { roomId: location.roomId } : {}),
        title: entry.title(payload),
        ...(entry.body?.(payload) ? { body: entry.body(payload) } : {}),
        ...(entry.actions ? { actions: entry.actions(payload) } : {}),
        createdAt: '2026-08-20T00:00:00.000Z',
      });
      expect(parsed.success, `${kind}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it('gives every kind the tier the spec assigns it', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const entry = notificationEntry(kind);
      expect(resolvePerKind(entry.tier, PAYLOADS[kind]), kind).toBe(EXPECTED_TIERS[kind]);
    }
  });

  it('makes a failed run louder than a successful one', () => {
    const entry = notificationEntry('run.completed');
    expect(resolvePerKind(entry.tier, { ...PAYLOADS['run.completed'], status: 'failed' })).toBe(
      'notable'
    );
    expect(resolvePerKind(entry.tier, { ...PAYLOADS['run.completed'], status: 'completed' })).toBe(
      'quiet'
    );
  });

  it('names exactly the kinds something actually raises today', () => {
    // The registry declares the whole vocabulary on purpose, but a declared kind
    // nobody emits is a promise rather than a feature. Every kind now has a
    // real emitter — `dm.received` / `mention.received` from
    // `services/rooms/room-service.ts` (DOR-1388), `report.daily` from
    // `emitters/shift-report.ts` (DOR-1389) — and each carries a comment at
    // its entry saying so.
    expect([...WIRED_NOTIFICATION_KINDS].sort()).toEqual([
      'agent.note',
      'agent.unreachable',
      'ask.pending',
      'dead-letter.created',
      'dm.received',
      'mention.received',
      'report.daily',
      'run.completed',
      'schedule.parked',
      'session.error',
      'turn.completed',
      'update.installed',
    ]);

    const reserved = NOTIFICATION_KINDS.filter((k) => !WIRED_NOTIFICATION_KINDS.includes(k));
    expect(reserved).toEqual([]);
  });

  it('stores exactly the three standing kinds only on resolution', () => {
    const standing = NOTIFICATION_KINDS.filter((k) => notificationEntry(k).storage === 'standing');
    expect([...standing].sort()).toEqual([...STANDING].sort());
  });

  it('lets a failed run reach out unconditionally and a successful one only on opt-in', () => {
    const entry = notificationEntry('run.completed');
    expect(resolvePerKind(entry.relay, { ...PAYLOADS['run.completed'], status: 'failed' })).toBe(
      'always'
    );
    expect(resolvePerKind(entry.relay, { ...PAYLOADS['run.completed'], status: 'completed' })).toBe(
      'opt-in'
    );
  });

  it('keeps every kind but the agent note and the run report inside the app', () => {
    const leaves = NOTIFICATION_KINDS.filter(
      (k) => resolvePerKind(notificationEntry(k).relay, PAYLOADS[k]) !== 'never'
    );
    expect([...leaves].sort()).toEqual(['agent.note', 'run.completed']);
  });

  it('builds a stable dedupe key that does not change between calls', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const entry = notificationEntry(kind);
      expect(entry.dedupeKey(PAYLOADS[kind])).toBe(entry.dedupeKey(PAYLOADS[kind]));
    }
  });

  it('gives two different subjects two different dedupe keys', () => {
    const entry = notificationEntry('run.completed');
    expect(entry.dedupeKey({ ...PAYLOADS['run.completed'], runId: 'run-2' })).not.toBe(
      entry.dedupeKey(PAYLOADS['run.completed'])
    );
  });

  it('gives every kind a dedupe key nobody else can collide with', () => {
    const keys = NOTIFICATION_KINDS.map((k) => notificationEntry(k).dedupeKey(PAYLOADS[k]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('tells two turns in one session apart, so a second turn is not swallowed', () => {
    const entry = notificationEntry('turn.completed');
    const first = entry.dedupeKey(PAYLOADS['turn.completed']);
    const second = entry.dedupeKey({
      ...PAYLOADS['turn.completed'],
      completedAt: '2026-08-20T00:05:00.000Z',
    });
    expect(second).not.toBe(first);
  });

  it('coalesces a DM burst by room, but gives every mention its own row', () => {
    // dm.received dedupes on the ROOM, deliberately coarser than every other
    // kind: two messages in one DM within the window are one notification.
    const dm = notificationEntry('dm.received');
    expect(dm.dedupeKey({ ...PAYLOADS['dm.received'], entryId: 'entry-2' })).toBe(
      dm.dedupeKey(PAYLOADS['dm.received'])
    );
    expect(dm.dedupeKey({ ...PAYLOADS['dm.received'], roomId: 'room-2' })).not.toBe(
      dm.dedupeKey(PAYLOADS['dm.received'])
    );

    // mention.received still dedupes per entry — each mention is its own event.
    const mention = notificationEntry('mention.received');
    expect(mention.dedupeKey({ ...PAYLOADS['mention.received'], entryId: 'entry-2' })).not.toBe(
      mention.dedupeKey(PAYLOADS['mention.received'])
    );
  });

  it('never puts a tool input in a title or a body', () => {
    // A notification title can end up on a phone lock screen. The Ask summary is
    // the tool's name or display name, never the command it proposed to run.
    const entry = notificationEntry('ask.pending');
    const payload = { ...PAYLOADS['ask.pending'], summary: 'Wants to run Bash' };
    expect(entry.title(payload)).not.toContain('rm -rf');
    expect(entry.body?.(payload)).toBe('Wants to run Bash');
  });

  it('offers approve and reject on a parked schedule and nothing on a quiet event', () => {
    expect(notificationEntry('schedule.parked').actions?.(PAYLOADS['schedule.parked'])).toEqual([
      { id: 'approve', label: 'Approve', style: 'primary' },
      { id: 'reject', label: 'Reject', style: 'danger' },
    ]);
    expect(notificationEntry('update.installed').actions).toBeUndefined();
  });
});
